const fs = require('fs')
const axios = require('axios')
const Web3 = require('web3')
const BigNumber = require('bignumber.js')
const ethUtil = require('ethereumjs-util')

const { generateMnemonic, EthHdWallet } = require('eth-hd-wallet')

const { WyvernProtocol } = require('wyvern-js')
const { tokens, schemas, encodeSell } = require('wyvern-schemas')

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

const postOrder = async (order) => {
  const hash = await protocolInstance.wyvernExchange.hashOrder_.callAsync(
    [order.exchange, order.maker, order.taker, order.feeRecipient, order.target, order.staticTarget, order.paymentToken],
    [order.makerFee, order.takerFee, order.basePrice, order.extra, order.listingTime, order.expirationTime, order.salt],
    order.side,
    order.saleKind,
    order.howToCall,
    order.calldata,
    order.replacementPattern,
    order.staticExtradata)
  if (hash !== order.hash) throw new Error('Hashes did not match: ', hash + ', ' + order.hash)
  const valid = await protocolInstance.wyvernExchange.validateOrder_.callAsync(
    [order.exchange, order.maker, order.taker, order.feeRecipient, order.target, order.staticTarget, order.paymentToken],
    [order.makerFee, order.takerFee, order.basePrice, order.extra, order.listingTime, order.expirationTime, order.salt],
    order.side,
    order.saleKind,
    order.howToCall,
    order.calldata,
    order.replacementPattern,
    order.staticExtradata,
    parseInt(order.v),
    order.r || '0x',
    order.s || '0x')
  if (!valid) throw new Error('Order did not pass validation!')
  return axios.post(`${config.orderbook_url}/v1/orders/post`, order)
}

const createOrder = (nft, amount) => {
  const { target, calldata, replacementPattern } = encodeSell(rinkebyNFTSchema, nft)
  const token = tokens.rinkeby.canonicalWrappedEther
  return {
    exchange: WyvernProtocol.getExchangeContractAddress('rinkeby'),
    maker: account,
    taker: WyvernProtocol.NULL_ADDRESS,
    makerFee: new BigNumber(0),
    takerFee: new BigNumber(0),
    feeRecipient: account,
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
      nft: nft
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
  if (!config.contract_address) {
    const rawTx = wallet.sign({
      from: account,
      data: MintableNonFungibleToken.bytecode,
      value: 0,
      nonce: nonce++,
      gasPrice: 3000000000,
      gasLimit: 2000000,
      chainId: 4
    })
    const txHash = await promisify(c => web3.eth.sendRawTransaction(rawTx, c))
    console.log(txHash)
    process.exit(0)
  }
  // const contract = new web3.eth.Contract(MintableNonFungibleToken.abi, config.contract_address)
  for (var nft = 0; nft < 50; nft++) {
    const order = createOrder(nft, Math.round(Math.random() * 1000) / 1000)
    const hash = WyvernProtocol.getOrderHashHex(order)
    const signature = await protocolInstance.signOrderHashAsync(hash, account)
    order.hash = hash
    order.r = signature.r
    order.s = signature.s
    order.v = signature.v
    await postOrder(order)
    console.log('Posted order to sell NFT #' + nft + ' - order hash: ' + hash)
    /*
    const mintBytecode = contract.mint(account, nft).encodeABI()
    const rawMintTx = wallet.sign({
      from: account,
      data: mintBytecode,
      value: 0,
      nonce: nonce++,
      gasPrice: 3000000000,
      gasLimit: 120000,
      chainId: 4
    })
    const mintTxHash = await promisify(c => web3.eth.sendSignedTransaction(rawMintTx, c))
    */
  }
}

(async () => {
  try {
    await go()
  } catch (e) {
    console.log(e)
  }
})()
