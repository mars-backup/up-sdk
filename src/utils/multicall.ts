import { Interface } from '@ethersproject/abi';
import { Contract } from '@ethersproject/contracts';
import { StaticJsonRpcProvider } from '@ethersproject/providers';

const multicallAbi = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)'
];

interface CALL {
  abi: any[];
  target: string;
  address: string;
  fn: string;
  params: any[];
  itf?: Interface;
}

export async function multicall(
  multicallAddress: string,
  rpcNode: string,
  calls: any[],
  options?: any
) {  
  const multi = new Contract(
    multicallAddress,
    multicallAbi,
    new StaticJsonRpcProvider(rpcNode)
  )

  calls.forEach(v => v.itf = new Interface(v.abi))
  const cs = calls.map(v => [
    v.address.toLowerCase(),
    v.itf?.encodeFunctionData(v.fn, v.params)
  ])

  try {
    const [, res] = await multi.aggregate(
      cs,
      options || {}
    )

    const ret: {[key: string]: any} = {}
    res.forEach((r: any, i: number) => {
      const v = calls[i]
      const n = v.itf?.decodeFunctionResult(v.fn, r) || []
      ret[v.target] = n.length > 1 ? n : n[0]
    })
    return ret
  } catch (e) {
    return Promise.reject(e)
  }
}