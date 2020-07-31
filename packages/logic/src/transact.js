const protocol = require('@fuel-js/protocol');
const utils = require('@fuel-js/utils');
const batch = require('@fuel-js/batch');
const struct = require('@fuel-js/struct');
const interface = require('@fuel-js/interface');

async function transact(unsigned = '0x', _witnesses = '0x', nonce = 0, config = {}) {
  try {
    // decoding
    const decoded = protocol.transaction.Unsigned.decodeRLP(unsigned);
    const witnesses = protocol.witness.decodePacked(_witnesses);
    const data = utils.toLowerCaseHex(decoded.properties.data().get());
    const inputs = protocol.inputs.decodePacked(decoded.properties.inputs().hex());
    const outputs = protocol.outputs.decodePacked(decoded.properties.outputs().hex());

    // mismatch length checks
    utils.assert(inputs.length === data.length, 'inputs-data-length-mismatch');

    // if testing mode
    if (!config.contract.address) {
      config.contract = {
        address: await config.db.get([ interface.db.contract ]),
      };
      config.contract.chainId = 0;
    }

    // gather ids, transaction hash ids
    const transactionHashId = protocol.witness.transactionHashId(
      decoded,
      config.contract,
      config.network.chainId
    );

    // Get Owner ids from Data
    const ownerIds = protocol.outputs.decodeOwnerIds(outputs);
    const ownerIdsKeys = ownerIds.map(id => [interface.db.address, id]);

    // Get State Registered Callers, if Any from Witnesses
    const callerWitnesses = protocol.witness.filter(witnesses);
    const callerKeys = callerWitnesses.map(witness => [
      interface.db.caller,
      witness.properties.owner().hex(),
      witness.properties.blockNumber().hex(),
    ]);

    // Ensure no duplicate inputs within the transaction itself, hashes are lowercased
    utils.assert(!utils.hasDuplicates(data))

    // gather necessary data from the database
    const inputKeys = inputs
      .map((input, i) => [
        interface.db.inputHash,
        input.properties.type().get(),
        0,
        data[i]
      ]);

    // Get all Keys in a single Batch Request to DB
    const getKeys = inputKeys
      .concat([
        [ interface.db.state ],
      ])
      .concat(ownerIdsKeys)
      .concat(callerKeys);

    // get all necessary state / keys from db
    const retrieve = (await batch(config.db, getKeys))
      .map(entry => entry.value);

    // Input Proofs, Owner IDs, Caller Ids
    let proofs = retrieve.slice(0, inputs.length);
    let values = retrieve.slice(inputs.length);
    const state = protocol.state.State(values[0]);
    const timestamp = utils.timestamp();

    // Parse Data Retrieved from DB
    const owners = values.slice(1, ownerIds.size).reduce((acc, value, i) => ({
      ...acc,
      [utils.bigstring(ownerIds[i])]: value,
    }), {});
    const callers = values.slice(1 + ownerIds.size, callerWitnesses.length).reduce((acc, transactionHashId, i) => ({
      ...acc,
      [callerWitnesses[i].keccak256()]: transactionHashId,
    }), {});

    // fee checking
    const feeToken = decoded.properties.signatureFeeToken().get();
    const fee = decoded.properties.signatureFee().get();
    utils.assert(feeToken.gte(0), 'fee-token-underflow');
    utils.assert(feeToken.lt(state.properties.numTokens().get()), 'fee-token-overflow');

    // inputs
    let ins = {};
    let spentInputs = inputKeys.map(key => ({
      type: 'put',
      key: [ interface.db.spent, key[1], key[3] ],
      value: '0x01',
    }));
    const inputHashes = inputKeys.map(v => v[3]);

    for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
      const input = inputs[inputIndex];
      const inputType = input.properties.type().get().toNumber();
      let proof = null, token = null, amount = null,
        owner = null, returnOwner = null, expiry = null;

      switch (inputType) {
        case protocol.inputs.InputTypes.Transfer:
          proof = proofs[inputIndex] = protocol.outputs.UTXO(proofs[inputIndex]);
          token = proof.properties.token().get();
          amount = proof.properties.amount().get();
          owner = proof.properties.owner().hex();
          break;

        case protocol.inputs.InputTypes.Deposit:
          proof = proofs[inputIndex] = protocol.deposit.Deposit(proofs[inputIndex]);
          token = proof.properties.token().get();
          amount = proof.properties.value().get();
          owner = proof.properties.owner().hex();
          break;

        case protocol.inputs.InputTypes.HTLC:
          proof = proofs[inputIndex] = protocol.outputs.UTXO(proofs[inputIndex]);
          token = proof.properties.token().get();
          amount = proof.properties.amount().get();
          owner = proof.properties.owner().hex();
          expiry = proof.properties.expiry().get();
          returnOwner = proof.properties.returnOwner().hex();

          spentInputs.push({
            type: 'del',
            key: [interface.db.owner, returnOwner, inputType, 0, proof.getAddon()[0], inputHashes[inputIndex]],
          });
          spentInputs.push({
            type: 'del',
            key: [interface.db.owner, returnOwner, inputType, 0, 0, inputHashes[inputIndex]],
          });

          utils.assert(expiry.gt(state.properties.blockNumber().get()), 'expiry-underflow');

          if (state.properties.blockNumber().get().gt(expiry)) {
            owner = returnOwner;
          } else {
            utils.assertHexEqual(utils.keccak256(input.properties.preImage().hex()),
              proof.properties.digest().hex(), 'htlc-pre-image');
          }
          break;

        case protocol.inputs.InputTypes.Root:
          proof = proofs[inputIndex] = protocol.root.RootHeader(proofs[inputIndex]);
          const rootAddon = protocol.addons.RootHeader(proof.getAddon());
          token = proof.properties.feeToken().get();
          amount = proof.properties.fee().get().mul(proof.properties.length().get());
          owner = rootAddon.properties.blockProducer.hex();
          utils.assert(rootAddon.properties.blockHeight.gt(0), 'invalid-root-spend');
          break;
      }

      spentInputs.push({
        type: 'del',
        key: [
          interface.db.owner,
          owner,
          inputType,
          0,
          proof.getAddon()[0],
          inputHashes[inputIndex]
        ],
      });
      spentInputs.push({
        type: 'del',
        key: [
          interface.db.owner,
          owner,
          inputType,
          0,
          0,
          inputHashes[inputIndex]
        ],
      });

      // increase ins
      ins[utils.bigstring(token)] = (ins[utils.bigstring(token)]
        || utils.bigNumberify(0)).add(amount);

      // witness reference
      const witnessReference = input.properties.witnessReference()
        .get().toNumber();

      // witness refernece
      utils.assert(witnesses[witnessReference], 'invalid-witness-reference');

      // check witnesses
      utils.assertHexEqual(owner, protocol
        .witness.recover(witnesses[witnessReference], transactionHashId, callers),
        'witness-recover');
    }

    // outputs
    let outs = {};
    let spendableOutputs = [];
    let spendableHashes = [];
    let accountOutputs = [];
    let emits = [];
    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
      const output = outputs[outputIndex];
      const outputType = output.properties.type().get().toNumber();
      let token = null, amount = null, owner = null,
        returnOwner = null, expiry = null, digest = null;

      switch (outputType) {
        case protocol.outputs.OutputTypes.Transfer:
          token = protocol.outputs.decodeToken(output, state);
          amount = protocol.outputs.decodeAmount(output);
          owner = protocol.outputs.decodeOwner(output, state, owners);
          break;

        case protocol.outputs.OutputTypes.Withdraw:
          token = protocol.outputs.decodeToken(output, state);
          amount = protocol.outputs.decodeAmount(output);
          owner = protocol.outputs.decodeOwner(output, state, owners);
          break;

        case protocol.outputs.OutputTypes.HTLC:
          token = protocol.outputs.decodeToken(output, state);
          amount = protocol.outputs.decodeAmount(output);
          owner = protocol.outputs.decodeOwner(output, state, owners);
          returnOwner = protocol.outputs.decodeReturnOwner(output, state, owners);
          expiry = output.properties.expiry().get();
          digest = output.properties.digest().get();
          break;

        case protocol.outputs.OutputTypes.Return:
          break;
      }

      // handle databasing of outputs
      if (outputType !== protocol.outputs.OutputTypes.Return) {
        const utxo = protocol.outputs.UTXO({
          transactionHashId,
          outputType,
          outputIndex,
          token,
          amount,
          owner,
          expiry,
          digest,
          returnOwner,
        }, protocol.addons.UTXO({ timestamp }));
        const hash = utxo.keccak256();
        const utxoRLP = utxo.encodeRLP();
        const isWithdraw = outputType === protocol.outputs.OutputTypes.Withdraw ? 1 : 0;

        if (returnOwner) {
          accountOutputs.push({
            type: 'put',
            key: [interface.db.owner, returnOwner, outputType, isWithdraw, 0, hash],
            value: hash,
          });

          // emit to publisher, if any
          if (config.emit) {
            try {
              emits.push({
                channel: `fuel_v1_${config.network.name}_${owner.toLowerCase()}`,
                message: utils.RLP.encode([
                  utils.bigNumberify(outputType).toHexString(),
                  isWithdraw ? '0x01' : '0x00',
                  token,
                  utxoRLP,
                ]),
              });
            } catch (error) { console.error(error); }
          }
        }

        accountOutputs.push({
          type: 'put',
          key: [interface.db.owner, owner, outputType, isWithdraw, 0, hash],
          value: hash,
        });

        // emit to publisher, if any
        if (config.emit) {
          try {
            emits.push({
              channel: `fuel_v1_${config.network.name}_${owner.toLowerCase()}`,
              message: utils.RLP.encode([
                utils.bigNumberify(outputType).toHexString(),
                isWithdraw ? '0x01' : '0x00',
                token,
                utxoRLP,
              ]),
            });
          } catch (error) { console.error(error); }
        }

        spendableOutputs.push({
          type: 'put',
          key: [interface.db.inputHash, output.properties.type().get(), isWithdraw, hash],
          value: utxo,
        });

        // Add to spendable hashes
        spendableHashes.push(!isWithdraw ? hash : utils.emptyBytes32);

        // increase outputs
        outs[utils.bigstring(token)] = (outs[utils.bigstring(token)]
          || utils.bigNumberify(0)).add(amount);
      } else {
        accountOutputs.push({
          type: 'put',
          key: [interface.db.return, transactionHashId, outputIndex],
          value: output.properties.data().hex(),
        });

        // Add to keep ordering correct
        spendableHashes.push(utils.emptyBytes32);
      }
    }

    // Additional transactional metadata
    const transactionAddon = protocol.addons.Transaction({
      data,
      inputsLength: inputs.length,
      outputsLength: outputs.length,
      witnessesLength: witnesses.length,
      timestamp,
      signatureFeeToken: feeToken,
      signatureFee: fee,
      spendableOutputs: spendableHashes,
    });

    // Build temporary transaction for storage
    let transaction = protocol.transaction._Transaction({
      metadata: protocol.addons.metadataFromProofs(inputs, proofs).map(m => m.encodePacked()),
      witnesses: struct.pack(...witnesses),
      ...decoded.object(),
    }, transactionAddon);
    transaction.properties.length().set(utils.hexDataLength(transaction.encodePacked()) - 2);

    // Set transaction leaf packed as the transaction in the addon
    transactionAddon.properties.transaction().set(transaction.encodePacked());

    // check leaf size
    const sizePacked = transaction.sizePacked();
    utils.assert(sizePacked > protocol.transaction.TransactionSizeMinimum,
        'transaction-size-underflow');
    utils.assert(sizePacked < protocol.transaction.TransactionSizeMaximum,
        'transaction-size-overflow');

    // add committed fee to outs
    if (fee.gt(0)) {
      outs[utils.bigstring(feeToken)] = (outs[utils.bigstring(feeToken)] || utils.bigNumberify(0))
        .add(fee.mul(transaction.sizePacked()));
    }

    // check ins === outs
    const outsKeys = Object.keys(outs).sort();
    const inKeys = Object.keys(ins).sort();
    inKeys.forEach((v, i) => {
      utils.assert(v === outsKeys[i], 'ins-outs-keys');
      utils.assert(ins[v].eq(outs[outsKeys[i]]), 'inputs-mismatch-outputs');
    });

    // The entry added to the mempool
    const mempoolEntry = [{
      type: 'put',
      key: [interface.db.mempool, timestamp, nonce, transactionHashId],
      value: transaction,
    }, {
      type: 'put',
      key: [
        interface.db.transactionId,
        transactionHashId,
      ],
      value: transactionAddon,
    }];

    // all is well, make database upserts
    await config.db.batch(spentInputs
        .concat(accountOutputs)
        .concat(spendableOutputs)
        .concat(mempoolEntry), { upsert: false, transact: true });

    // new emit
    if (config.emit) {
      try {
        for (const emittion of emits) {
          await config.emit(emittion);
        }
      } catch (emitError) {
        console.error(emitError);
      }
    }

    // bool success for now..
    return '0x01';
  } catch (error) {
    console.error(error);
    throw new utils.ByPassError(error);
  }
}

module.exports = transact;
