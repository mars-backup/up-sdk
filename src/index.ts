import _ from 'lodash'
import BigNumber from 'bignumber.js'
import { multicall } from './utils/multicall'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { Cache } from './utils/cache'
import { BigNumber as BN } from '@ethersproject/bignumber'

const BSC_BLOCK_TIME = 3
const BLOCKS_PER_YEAR = new BigNumber((60 / BSC_BLOCK_TIME) * 60 * 24 * 365)

interface Token {
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

interface Context {
  chainId: string;
  rpcNode: string;
  multiCallAddress: string;
  cache: Cache;
  tokens: { [key: string]: Token };
  config: any;
  getToken: (symbol: string) => Token;
}

function etherToBn(v: any) {
  return new BigNumber(v.toString())
}

function BnToNumber(n: BigNumber, decimals: number = 0) {
  return n.dp(decimals, BigNumber.ROUND_FLOOR).toNumber()
}

interface Options {
  chainId?: string
  rpcNode?: string
  suffix?: string
  others?: any
}

type TokenPrice = { token: Token; price: BigNumber | null | undefined }

function tokenEqual(a: Token, b: Token) {
  return a.address.toLowerCase() == b.address.toLowerCase()
}

function getRouteFarm(lp: any, preferredQuoteTokens: TokenPrice[], refers: any[], results: any[] = []): any[] {
  if (results.length > 4)
    return []

  const { quoteToken } = lp;
  const found = preferredQuoteTokens.find(v => tokenEqual(v.token, quoteToken))
  if (found) {
    results.push(lp)
    return results
  }

  const findFarms = refers.filter(v => tokenEqual(quoteToken, v.baseToken) && !results.find(n => tokenEqual(n.baseToken, v.baseToken) && tokenEqual(n.quoteToken, v.quoteToken)))
  if (findFarms.length > 0) {
    results.push(lp)
    for (let i = 0; i < findFarms.length; i++) {
      const n = findFarms[i]
      const v = getRouteFarm(n, preferredQuoteTokens, refers, results)
      if (v.length > 0)
        return v
    }
  }

  return []
}

function getRouteFarmPrice(target: any, tokens: TokenPrice[], farms: any[]) {
  const refers = [...farms, ...farms.map(v => ({
    baseToken: v.quoteToken,
    quoteToken: v.baseToken,
    tokenPriceVsQuote: v.tokenPriceVsQuote.eq(0) ? new BigNumber(0) : new BigNumber(1).div(v.tokenPriceVsQuote)
  }))]

  const targetResult = {
    baseToken: target,
    quoteToken: target,
    tokenPriceVsQuote: new BigNumber(1)
  }

  const results = getRouteFarm(targetResult, tokens, refers)
  if (results.length == 0) {
    console.error(`Can't calc price of ${target.symbol}`)
    return null
  }

  const end = results[results.length - 1]
  const tokenPrice = tokens.find(v => tokenEqual(v.token, end.quoteToken))
  return results.reduce((prev, cur) => prev.times(cur.tokenPriceVsQuote), tokenPrice?.price)
}

async function getPriceToken(
  ctx: Context
) {
  const abi = [ 'function balanceOf(address _owner) external view returns (uint256)' ]
  const { priceHelper } = ctx.config
  const calls = _.flatten(priceHelper.map((v: any) => ([
    {
      abi,
      target: v.address + '-0',
      address: ctx.getToken(v.baseToken).address,
      fn: 'balanceOf',
      params: [v.address]
    },
    {
      abi,
      target: v.address + '-1',
      address: ctx.getToken(v.quoteToken).address,
      fn: 'balanceOf',
      params: [v.address]
    }
  ])))

  const result = await multicall(
    ctx.multiCallAddress,
    ctx.rpcNode,
    calls
  )

  const priceTokens = priceHelper.map((v: any) => {
    const baseAmount = new BigNumber(result[v.address + '-0'].toString());
    const quotoAmount = new BigNumber(result[v.address + '-1'].toString());
    return {
      address: v.address,
      baseToken: ctx.getToken(v.baseToken),
      quoteToken: ctx.getToken(v.quoteToken),
      tokenPriceVsQuote: baseAmount.eq(0) ? new BigNumber(0) : quotoAmount.div(baseAmount)
    }
  });

  return priceTokens;
}

async function getOraclePrices(ctx: Context) {
  const oracles = ctx.config.oracles
  const abi = [ 'function getLatestPrice() external view returns (uint256,uint8)' ]
  const calls = oracles.map((v: any) => ({
    abi,
    target: v.token,
    address: v.address,
    fn: 'getLatestPrice',
    params: []
  }))
  const result = await multicall(
    ctx.multiCallAddress,
    ctx.rpcNode,
    calls
  )
  return oracles.map((v: any) => ({
    token: ctx.getToken(v.token),
    price: new BigNumber(result[v.token][0].toString()).div(new BigNumber(10).pow(result[v.token][1]))
  }))
}

async function getLPs(ctx: Context, lps: string[]) {
  const abi = [
    'function token0() external view returns (address)',
    'function getReserves() external view returns (uint256,uint256)',
    'function totalSupply() external view returns (uint256)',
  ]
  const calls = _.flatten(lps.map((v: any) => ([
    {
      abi,
      target: v + 'token0',
      address: v,
      fn: 'token0',
      params: []
    },
    {
      abi,
      target: v + 'getReserves',
      address: v,
      fn: 'getReserves',
      params: []
    },
    {
      abi,
      target: v + 'totalSupply',
      address: v,
      fn: 'totalSupply',
      params: []
    }
  ])))
  const result = await splitMC(ctx, calls)
  return lps.map((v: any) => ({
    address: v,
    token0: result[v + 'token0'],
    reserves: result[v + 'getReserves'].map((v: any) => etherToBn(v)),
    totalSupply: etherToBn(result[v + 'totalSupply'])
  }))
}

interface POOL {
  alias: string;
  wantToken: string;
  baseToken: string;
  quoteToken: string;
  earnToken: string;
  strategy: string;
  localFarm: string;
  localFarmPid: number;
  remoteFarm: string;
  remoteFarmPid: number;
}

interface STAKING {
  alias: string;
  wantToken: string;
  baseToken: string;
  quoteToken: string;
  earnToken: string;
  strategy: string;
  localFarm: string;
  localFarmPid: number;
}

const MULTICALL_STEP = 20

async function splitMC(ctx: Context, calls: any[]) {
  const total = _.size(calls)
  const cnt = _.max([ _.floor(total / MULTICALL_STEP), 1 ]) as number
  const avg = _.ceil(total / cnt)
  const splitted = []
  for (let i = 0; i < cnt; i++) {
    splitted.push(calls.slice(avg * i, avg * (i + 1)))
  }
  const rs = await Promise.all(splitted.map(v => multicall(
    ctx.multiCallAddress,
    ctx.rpcNode,
    v
  )))
  return rs.reduce((ret, v) => _.merge(ret, v), {})
}

async function getPoolAmount(ctx: Context) {
  const abi = [
    'function wantLockedTotal() external view returns (uint256)',
    'function totalSupply() external view returns (uint256)',
    'function balanceOf(address) external view returns (uint256)'
  ]
  const pools: POOL[] = ctx.config.pools
  const calls = pools.map(v => ({
    abi,
    target: v.strategy,
    address: v.strategy,
    fn: 'wantLockedTotal',
    params: []
  }))

  const stakings: STAKING[] = ctx.config.stakings
  const calls2 = stakings.map(v => {
    const isUp = v.baseToken == 'up' && v.quoteToken == 'up'
    const farmAddress = ctx.config.localFarms.find((x: any) => x.name == v.localFarm).address
    return {
      abi,
      target: v.alias,
      address: isUp ? farmAddress : v.wantToken,
      fn: isUp ? 'totalSupply' : 'balanceOf',
      params: isUp ? [] : [ farmAddress ]
    }
  })

  const result = await splitMC(ctx, [ ...calls, ...calls2 ])
  return [
    ...pools.map(v => etherToBn(result[v.strategy])),
    ...stakings.map(v => etherToBn(result[v.alias]))
  ]
}

async function getTVL(ctx: Context) {
  const pools: POOL[] = ctx.config.pools
  const stakings: STAKING[] = ctx.config.stakings
  const all = [ ...pools, ...stakings ]
  const lps = _.uniq(all.filter(v => v.baseToken != v.quoteToken).map(v => v.wantToken))
  const [
    oraclePrices,
    priceTokens,
    LPs,
    poolAmounts
  ] = await Promise.all([ getOraclePrices(ctx), getPriceToken(ctx), getLPs(ctx, lps), getPoolAmount(ctx) ])

  const tvls = all.map((v, i) => {
    const quoteToken = ctx.getToken(v.quoteToken)
    const quoteTokenPrice = getRouteFarmPrice(quoteToken, oraclePrices, priceTokens)
    let lpPrice
    if (v.baseToken == v.quoteToken) {
      lpPrice = quoteTokenPrice
    } else {
      const lp = LPs.find(x => x.address == v.wantToken)!
      const isToken0 = lp.token0.toLowerCase() == quoteToken.address.toLowerCase()
      const reserve: BigNumber = lp.reserves[isToken0 ? 0 : 1]
      lpPrice = quoteTokenPrice.times(reserve).times(2).div(lp.totalSupply)
    }
    return {
      alias: v.alias,
      tvl: lpPrice.times(poolAmounts[i]).div(1e18)
    }
  })
 
  const total = tvls.reduce((sum, v) => sum = sum.plus(v.tvl), new BigNumber(0))
  return {
    total: BnToNumber(total, 8),
    detail: tvls.map(v => ({
      alias: v.alias,
      tvl: BnToNumber(v.tvl, 8)
    }))
  }
}

async function _getTokenPrice(
  ctx: Context,
  token: string,
  pair: string,
  oracle: string
) {
  const abi = [
    'function getLatestPrice() external view returns (uint256,uint8)',
    'function token0() external view returns (address)',
    'function getReserves() external view returns (uint256,uint256)',
  ]

  const calls = [
    {
      abi,
      target: 'latestPrice',
      address: oracle,
      fn: 'getLatestPrice',
      params: []
    },
    {
      abi,
      target: 'token0',
      address: pair,
      fn: 'token0',
      params: []
    },
    {
      abi,
      target: 'getReserves',
      address: pair,
      fn: 'getReserves',
      params: []
    }
  ]

  const result = await multicall(ctx.multiCallAddress, ctx.rpcNode, calls)

  const [ _price, decimals ] = result['latestPrice']
  const tokenPrice = new BigNumber(_price.toString())
  const [ _reserve0, _reserve1 ] = result['getReserves']
  const reserve0 = new BigNumber(_reserve0.toString())
  const reserve1 = new BigNumber(_reserve1.toString())
  const token0 = token.toLowerCase() == result['token0'].toLowerCase()

  let price = new BigNumber(0)
  if (!reserve0.eq(0)) {
    if (token0) {
      price = tokenPrice.times(reserve1).div(reserve0.times(new BigNumber(10).pow(decimals)))
    } else {
      price = tokenPrice.times(reserve0).div(reserve1.times(new BigNumber(10).pow(decimals)))
    }
  }

  const priceRelated = token0 ? reserve1.div(reserve0) : reserve0.div(reserve1)
  return { price, priceRelated }
}

async function getUPPrice(ctx: Context) {
  const upToken = ctx.getToken('up')
  const [
    oraclePrices,
    priceTokens
  ] = await Promise.all([ getOraclePrices(ctx), getPriceToken(ctx) ])
  return getRouteFarmPrice(upToken, oraclePrices, priceTokens)
}

async function getCirculatingSupply(ctx: Context) {
  const fixSupplyAddresses: string[] = ctx.config.fixSupplyAddresses
  const upToken = ctx.getToken('up')
  const abi = [
    'function totalSupply() external view returns (uint256)',
    'function balanceOf(address) external view returns (uint256)'
  ]
  const calls = [
    {
      abi,
      target: 'totalSupply',
      address: upToken.address,
      fn: 'totalSupply',
      params: []
    },
    ...fixSupplyAddresses.map(v => ({
      abi,
      target: v,
      address: upToken.address,
      fn: 'balanceOf',
      params: [ v ]
    }))
  ]
  const result = await splitMC(ctx, calls)
  let total: BN = result['totalSupply']
  fixSupplyAddresses.forEach(v => total = total.sub(result[v]))
  return new BigNumber(total.toString())
}

async function getMarketCap(ctx: Context) {
  const [
    price,
    circulatingSupply
  ] = await Promise.all([ getUPPrice(ctx), getCirculatingSupply(ctx) ])
  return price.times(circulatingSupply).div(1e18)
}

export class UpSdk {

  provider: StaticJsonRpcProvider
  cache: Cache

  public tokens: {[key: string]: Token}
  public config: any
  public multiCallAddress: string
  public chainId: string;
  public rpcNode: string

  constructor(options: Options = {}) {
    const { chainId = '56', rpcNode, suffix = '' } = options

    this.chainId = chainId
    if (!rpcNode) {
      this.rpcNode = (chainId == '56') ? 'https://bsc-dataseed.binance.org/' : 'https://data-seed-prebsc-2-s2.binance.org:8545/'
    } else {
      this.rpcNode = rpcNode
    }

    this.provider = new StaticJsonRpcProvider(rpcNode)
    this.cache = new Cache()
    this.config = require(`../json/${chainId}${suffix}/config.json`)
    this.multiCallAddress = this.config.multiCall

    const tokenMap: {[key: string]: Token} = {}
    const _tokens = require(`../json/${chainId}${suffix}/tokenlist.json`).tokens
    _tokens.forEach((v: any) => tokenMap[v.symbol.toLowerCase()] = _.pick(v, ['address','decimals','symbol','name']))
    this.tokens = tokenMap
  }

  public getToken(symbol: string) {
    return this.tokens[symbol.toLowerCase()]
  }

  public async tvl(withCache: boolean = true) {
    if (!withCache)
      return getTVL(this)

    const self = this
    return self.cache.remember('getTVL', async () => {
      return getTVL(self)
    })
  }

  public async upPrice(withCache: boolean = true) {
    if (!withCache)
      return getUPPrice(this)

    const self = this
    return self.cache.remember('upPrice', async () => {
      return getUPPrice(self)
    })
  }

  public async marketCap(withCache: boolean = true) {
    if (!withCache)
      return getMarketCap(this)

    const self = this
    return self.cache.remember('marketCap', async () => {
      return getMarketCap(self)
    })
  }
}
