import NodeCache from 'node-cache'

interface Options {
  ttl?: number;
  checkperiod?: number;
}

export class Cache extends NodeCache {

  constructor(options?: Options) {
    super({
      stdTTL: options?.ttl || 10,
      checkperiod: options?.checkperiod || 600
    })
  }

  public async remember(key: string, fn: () => Promise<any>) {
    let v = this.get(key)
    if (v != null)
      return v

    v = await fn()
    this.set(key, v)
    return v
  }

}