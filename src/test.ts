import { UpSdk } from "./index"

async function main() {

  const sdk = new UpSdk({ chainId: '56' })

  const tvl = await sdk.tvl()
  console.log(tvl)

  const price = await sdk.upPrice()
  console.log(price.toString(10))

  const marketCap = await sdk.marketCap()
  console.log(marketCap.toString(10))
}

main()
