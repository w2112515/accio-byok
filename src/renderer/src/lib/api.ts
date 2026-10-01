import type { AccioSwitchApi, ApiMethod, PreloadBridge } from '../../../shared/api.ts'

declare global {
  interface Window {
    accioSwitch: PreloadBridge
  }
}

function strip(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  // "Error invoking remote method 'api': Error: xxx" → "xxx"
  return new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
}

export const api = new Proxy({} as AccioSwitchApi, {
  get(_t, method: string) {
    return (...args: unknown[]) =>
      (window.accioSwitch.invoke as (m: ApiMethod, ...a: unknown[]) => Promise<unknown>)(method as ApiMethod, ...args).catch((e) => {
        throw strip(e)
      })
  },
})

export const onAppEvent = (cb: Parameters<PreloadBridge['onEvent']>[0]) => window.accioSwitch.onEvent(cb)
