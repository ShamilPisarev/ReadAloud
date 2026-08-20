import { contextBridge, ipcRenderer } from 'electron';
import type { PlayerBridge, PlayerStatePayload, ReadTextPayload } from '../shared/ipc';

const bridge: PlayerBridge = {
  onReadText(callback: (payload: ReadTextPayload) => void): void {
    ipcRenderer.on('read-text', (_event, payload: ReadTextPayload) => callback(payload));
  },
  onStop(callback: () => void): void {
    ipcRenderer.on('stop-playback', () => callback());
  },
  reportState(state: PlayerStatePayload): void {
    ipcRenderer.send('player-state', state);
  },
  captureSelection(): void {
    ipcRenderer.send('capture-selection');
  },
  captureRegion(): void {
    ipcRenderer.send('capture-region');
  },
  readClipboard(): void {
    ipcRenderer.send('read-clipboard');
  },
  openExternal(url: string): void {
    ipcRenderer.send('open-external', url);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('readAloud', bridge);

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('renderer-ready');
});
