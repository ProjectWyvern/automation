const fs = require('fs')
const Web3 = require('web3')
const BigNumber = require('bignumber.js')
const ethUtil = require('ethereumjs-util')

const { generateMnemonic, EthHdWallet } = require('eth-hd-wallet')

const { WyvernProtocol } = require('wyvern-js')
const { tokens, schemas, encodeSell } = require('wyvern-schemas')
const { WyvernExchange, feeRecipient } = require('wyvern-exchange')

var mnemonic
try {
  mnemonic = fs.readFileSync('./mnemonic').toString()
} catch (err) {
  mnemonic = generateMnemonic()
  fs.writeFileSync('./mnemonic', mnemonic)
}
const wallet = EthHdWallet.fromMnemonic(mnemonic)
const account = wallet.generateAddresses(1)[0]
const config = require('./config.json')
const wyvernExchange = new WyvernExchange(config.orderbook_url)
const MintableNonFungibleToken = require('./MintableNonFungibleToken.json')
const ZeroClientProvider = require('web3-provider-engine/zero.js')
const HookedWalletEthTxSubprovider = require('web3-provider-engine/subproviders/hooked-wallet-ethtx.js')
const hookedWalletEthTxSubprovider = new HookedWalletEthTxSubprovider({
  getAccounts: cb => cb(null, [account]),
  getPrivateKey: (address, cb) => cb(null, wallet._children[0].wallet.getPrivateKey())
})
const concatSig = (v, r, s) => {
  r = ethUtil.fromSigned(r)
  s = ethUtil.fromSigned(s)
  v = ethUtil.bufferToInt(v)
  r = ethUtil.toUnsigned(r).toString('hex')
  s = ethUtil.toUnsigned(s).toString('hex')
  v = ethUtil.stripHexPrefix(ethUtil.intToHex(v))
  return ethUtil.addHexPrefix(r.concat(s, v).toString('hex'))
}
const engine = ZeroClientProvider({
  getAccounts: hookedWalletEthTxSubprovider.getAccounts,
  signTransaction: hookedWalletEthTxSubprovider.signTransaction,
  signMessage: (params, cb) => {
    const priv = wallet._children[0].wallet.getPrivateKey()
    const sig = ethUtil.ecsign(Buffer.from(params.data.slice(2), 'hex'), priv)
    const serialized = ethUtil.bufferToHex(concatSig(sig.v, sig.r, sig.s))
    cb(null, serialized)
  },
  rpcUrl: config.web3_provider
})
engine.on('error', console.log)
const web3 = new Web3(engine)
const protocolInstance = new WyvernProtocol(engine, {network: 'rinkeby', gasPrice: 1000000})
const rinkebyNFTSchema = schemas.rinkeby.filter(x => x.name === 'TestRinkebyNFT')[0]

const promisify = (inner) =>
  new Promise((resolve, reject) =>
    inner((err, res) => {
      if (err) { reject(err) }
      resolve(res)
    })
  )

const createOrder = (nft, amount) => {
  const { target, calldata, replacementPattern } = encodeSell(rinkebyNFTSchema, nft)
  const token = tokens.rinkeby.canonicalWrappedEther
  return {
    exchange: WyvernProtocol.getExchangeContractAddress('rinkeby'),
    maker: account,
    taker: WyvernProtocol.NULL_ADDRESS,
    makerFee: new BigNumber(0),
    takerFee: new BigNumber(0),
    feeRecipient: feeRecipient.toLowerCase(),
    side: '1',
    saleKind: '0',
    target: target,
    howToCall: '0',
    calldata: calldata,
    replacementPattern: replacementPattern,
    staticTarget: WyvernProtocol.NULL_ADDRESS,
    staticExtradata: '0x',
    paymentToken: token.address,
    basePrice: (new BigNumber(amount)).mul((new BigNumber(10)).pow(token.decimals)),
    extra: new BigNumber(0),
    listingTime: new BigNumber(Math.round(Date.now() / 1000)),
    expirationTime: new BigNumber(Math.round((Date.now() / 1000) + 86400)),
    salt: WyvernProtocol.generatePseudoRandomSalt(),
    metadata: {
      schema: 'TestRinkebyNFT',
      asset: '' + nft
    }
  }
}

const go = async () => {
  engine.start()
  console.log('Ethereum account: ' + account)
  const balance = await promisify(c => web3.eth.getBalance(account, c))
  console.log('Balance: ' + balance)
  if (balance === 0) {
    throw new Error('Nonzero balance required!')
  }
  var nonce = await promisify(c => web3.eth.getTransactionCount(account, c))
  var proxy = await protocolInstance.wyvernProxyRegistry.proxies.callAsync(account)
  console.log('Proxy: ' + proxy)
  if (proxy === WyvernProtocol.NULL_ADDRESS) {
    const txData = protocolInstance.wyvernProxyRegistry.registerProxy.getABIEncodedTransactionData()
    const rawTx = wallet.sign({
      from: account,
      to: WyvernProtocol.getProxyRegistryContractAddress('rinkeby'),
      data: txData,
      value: 0,
      nonce: nonce++,
      gasPrice: 3000000000,
      gasLimit: 2000000,
      chainId: 4
    })
    const txHash = await promisify(c => web3.eth.sendRawTransaction(rawTx, c))
    console.log('Creating proxy; TX: ' + txHash)
    await protocolInstance.awaitTransactionMinedAsync(txHash)
    proxy = await protocolInstance.wyvernProxyRegistry.proxies.callAsync(account)
    console.log('Proxy: ' + proxy)
  }
  const contract = web3.eth.contract(MintableNonFungibleToken.abi).at(config.contract_address)
  var myNFTs = []
  var proxyNFTs = []
  var index = 0
  while (true) {
    var mine = await promisify(c => contract.tokenOfOwnerByIndex.call(account, index, c))
    mine = mine.toNumber()
    if (mine === 0) {
      break
    } else {
      myNFTs.push(mine)
      index++
    }
  }
  for (var ind = 0; ind < myNFTs.length; ind++) {
    const txData = contract.transfer.getData(proxy, myNFTs[ind])
    const rawTx = wallet.sign({from: account, to: contract.address, data: txData, value: 0, nonce: nonce++, gasPrice: 2000000000, gasLimit: 200000, chainId: 4})
    const txHash = await promisify(c => web3.eth.sendRawTransaction(rawTx, c))
    console.log('Transferring NFT #' + myNFTs[ind] + ' to proxy: ' + txHash)
  }
  if (myNFTs.length > 0) {
    process.exit(0)
  }
  index = 0
  while (true) {
    var proxys = await promisify(c => contract.tokenOfOwnerByIndex.call(proxy, index, c))
    proxys = proxys.toNumber()
    if (proxys === 0) {
      break
    } else {
      proxyNFTs.push(proxys)
      index++
    }
  }
  proxyNFTs.sort()
  for (ind = 51; ind < proxyNFTs.length; ind++) {
    const nft = proxyNFTs[ind]
    const order = createOrder(nft, Math.round(Math.random() * 10) / 1000)
    const hash = WyvernProtocol.getOrderHashHex(order)
    const signature = await protocolInstance.signOrderHashAsync(hash, account)
    order.hash = hash
    order.r = signature.r
    order.s = signature.s
    order.v = signature.v
    await wyvernExchange.postOrder(order)
    await promisify(c => setTimeout(() => c(null, null), 3000))
    console.log('Posted order to sell NFT #' + nft + ' - order hash: ' + hash)
  }
}

(async () => {
  try {
    await go()
  } catch (e) {
    console.log(e)
  }
})()
