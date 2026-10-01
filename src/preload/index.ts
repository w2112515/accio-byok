import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PreloadBridge } from '../shared/api.ts'
import type { AppEvent } from '../shared/types.ts'

const bridge: PreloadBridge = {
  invoke: ((method: string, ...args: unknown[]) => ipcRenderer.invoke('api', method, ...args)) as PreloadBridge['invoke'],
  onEvent(cb) {
    const listener = (_e: IpcRendererEvent, payload: AppEvent) => cb(payload)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  },
}

contextBridge.exposeInMainWorld('accioSwitch', bridge)
