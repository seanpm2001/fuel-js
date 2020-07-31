function sample(arr = []) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function median(array = []) {
  let _array = [...array].sort(function(a, b) {
    return a.sub(b);
  });
  var mid = _array.length / 2;
  return mid % 1 ? _array[mid - 0.5] : (_array[mid - 1].add(_array[mid])).div(2);
}

// gasPrice, use an ethers provider object and it will do the rest, opts { sampleSize, sampleTarget }
async function gasPrice(provider = {}, opts = {}) {
  try {
    let transactionHashes = [];
    let gasPrices = [];
    const height = await provider.getBlockNumber();

    for (let blockNumber = height;
      (blockNumber > 0 && transactionHashes.length < (opts.sampleTarget || 15));
      blockNumber--) {
      const block = await provider.getBlock(blockNumber);

      // do 10 sample attempts
      for (let i = 0; i < (opts.sampleSize || 5); i++) {
        if (block.transactions && (block.transactions || {}).length > 0) {
          const _random = sample(block.transactions);

          if (_random) {
            transactionHashes.push(_random);
          }
        }
      }

      // remove deuplicates
      transactionHashes = [...new Set(transactionHashes)];
    }

    // go through transaction hashes
    for (const transactionHash of transactionHashes) {
      if (transactionHash) {
        const transaction = await provider.getTransaction(transactionHash);
        gasPrices.push(transaction.gasPrice);
      }
    }

    // get network gas price
    const network = await provider.getGasPrice();

    // add the network price in there as well
    gasPrices.push(network);

    // median
    const _median = median(gasPrices);

    // sorted
    const sorted = gasPrices.sort((a, b) => a.sub(b));

    return {
      network,
      fast: sorted.slice(-1)[0],
      safe: [network, _median].sort((a, b) => a.sub(b)).slice(-1)[0],
      median: _median,
      low: sorted[0],
    };
  } catch (error) {
    throw new Error(error.message);
  }
}

module.exports = gasPrice;
