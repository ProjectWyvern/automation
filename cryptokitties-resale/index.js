const fs = require('fs')
const Web3 = require('web3')
const axios = require('axios')
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
const SaleClockAuction = require('./SaleClockAuction.json')
const AuthenticatedProxy = require('./AuthenticatedProxy.json')
const WyvernAtomicizer = require('./WyvernAtomicizer.json')
const wyvernExchange = new WyvernExchange(config.orderbook_url)
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
const protocolInstance = new WyvernProtocol(engine, {network: 'main', gasPrice: 4100000000})
const cryptoKittiesSchema = schemas.main.filter(x => x.name === 'CryptoKitties')[0]

const promisify = (inner) =>
  new Promise((resolve, reject) =>
    inner((err, res) => {
      if (err) { reject(err) }
      resolve(res)
    })
  )

const createAndPostOrder = async (nft, amount) => {
  const { target, calldata, replacementPattern } = encodeSell(cryptoKittiesSchema, nft)
  const token = tokens.main.canonicalWrappedEther
  const order = {
    exchange: WyvernProtocol.getExchangeContractAddress('main'),
    maker: account,
    taker: WyvernProtocol.NULL_ADDRESS,
    makerFee: new BigNumber(0),
    takerFee: new BigNumber(0),
    feeRecipient: feeRecipient.toLowerCase(),
    side: '1',
    saleKind: '1',
    target: target,
    howToCall: '0',
    calldata: calldata,
    replacementPattern: replacementPattern,
    staticTarget: WyvernProtocol.NULL_ADDRESS,
    staticExtradata: '0x',
    paymentToken: token.address,
    basePrice: (new BigNumber(amount)).mul((new BigNumber(10)).pow(token.decimals)),
    extra: (new BigNumber(amount)).mul((new BigNumber(10)).pow(token.decimals)), // down to zero
    listingTime: new BigNumber(Math.round(Date.now() / 1000) - 20), // adjust a bit before now for clock skew
    expirationTime: new BigNumber(Math.round((Date.now() / 1000) + 3600)),
    salt: WyvernProtocol.generatePseudoRandomSalt(),
    metadata: {
      schema: 'CryptoKitties',
      asset: '' + nft
    }
  }
  const hash = WyvernProtocol.getOrderHashHex(order)
  const signature = await protocolInstance.signOrderHashAsync(hash, account)
  order.hash = hash
  order.r = signature.r
  order.s = signature.s
  order.v = signature.v
  await wyvernExchange.postOrder(order)
  console.log('Posted order with hash: ' + hash)
}

const poll = async (contract, atomicizer, proxy, nonce) => {
  const response = await axios.get('https://api.cryptokitties.co/auctions?offset=0&limit=20&type=sale&status=open&orderBy=current_price&orderDirection=asc&parents=false&authenticated=true')
  var auctions = response.data.auctions
  const now = Date.now()
  auctions.map(a => {
    a.end_time = parseInt(a.end_time)
    a.start_time = parseInt(a.start_time)
    a.fraction = (now - a.start_time) / (a.end_time - a.start_time)
  })
  auctions = auctions.filter(a => a.fraction < 1)
  auctions.sort((x, y) => x.fraction > y.fraction ? -1 : 1)
  const selected = auctions[0]
  if (selected && selected.fraction > 0.9) {
    const encodedBid = contract.bid.getData(selected.kitty.id)
    const encodedAtomic = atomicizer.atomicize.getData(['0xb1690c08e213a35ed9bab7b318de14420fb57d8c'], [selected.current_price], [(encodedBid.length - 2) / 2], encodedBid)
    const encodedProxy = proxy.proxyAssert.getData('0xC99f70bFD82fb7c8f8191fdfbFB735606b15e5c5', 1, encodedAtomic)
    return encodedProxy
  }
  return null
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
      to: WyvernProtocol.getProxyRegistryContractAddress('main'),
      data: txData,
      value: 0,
      nonce: nonce++,
      gasPrice: 4100000000,
      gasLimit: 500000,
      chainId: 1
    })
    const txHash = await promisify(c => web3.eth.sendRawTransaction(rawTx, c))
    console.log('Creating proxy; TX: ' + txHash)
    await protocolInstance.awaitTransactionMinedAsync(txHash)
    proxy = await protocolInstance.wyvernProxyRegistry.proxies.callAsync(account)
    console.log('Proxy: ' + proxy)
  }
  const contract = web3.eth.contract(SaleClockAuction).at('0xb1690c08e213a35ed9bab7b318de14420fb57d8c')
  const atomicizer = web3.eth.contract(WyvernAtomicizer).at('0xC99f70bFD82fb7c8f8191fdfbFB735606b15e5c5')
  const proxyContract = web3.eth.contract(AuthenticatedProxy).at(proxy)
  while (true) {
    const orders = await wyvernExchange.orders({maker: account})
    const already = orders.map(o => o.asset.asset)
    const resp = await axios.get('https://api.cryptokitties.co/kitties?offset=0&limit=20&owner_wallet_address=' + proxy + '&parents=false&authenticated=true')
    const kitties = resp.data.kitties.map(k => k.id)
    await Promise.all(kitties.map(id => {
      if (already.indexOf(id.toString()) === -1) {
        return createAndPostOrder(id, 0.01)
      }
    }))
    await promisify(c => setTimeout(() => c(null, null), 5000))
    const txData = await poll(contract, atomicizer, proxyContract)
    if (txData) {
      const rawTx = wallet.sign({from: account, to: proxy, data: txData, value: 0, nonce: nonce++, gasPrice: 4100000000, gasLimit: 400000, chainId: 1})
      const txHash = await promisify(c => web3.eth.sendRawTransaction(rawTx, c))
      console.log('Commit purchase: ' + txHash)
      await promisify(c => setTimeout(() => c(null, null), 1000 * 60 * 3))
    }
  }
}

(async () => {
  try {
    await go()
  } catch (e) {
    console.log(e)
  }
})()
