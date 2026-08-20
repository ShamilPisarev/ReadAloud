import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayBridge, RegionRect } from '../shared/ipc';

const bridge: OverlayBridge = {
  complete(rect: RegionRect): void {
    ipcRenderer.send('overlay-done', rect);
  },
  cancel(): void {
    ipcRenderer.send('overlay-cancel');
  },
};

contextBridge.exposeInMainWorld('overlay', bridge);
