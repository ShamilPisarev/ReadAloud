/** Typed contracts for main ⇄ renderer IPC. */

/** Where captured text came from. */
export type CaptureSource = 'selection' | 'clipboard' | 'ocr' | 'manual';

/** Main → player renderer: start reading this text. */
export interface ReadTextPayload {
  text: string;
  source: CaptureSource;
}

/** Player renderer → main: playback status for tray/smoke-test visibility. */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerStatePayload {
  status: PlayerStatus;
  errorMessage: string | null;
}

/** Region-select overlay → main: chosen rectangle in CSS pixels. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** API exposed to the player window via contextBridge. */
export interface PlayerBridge {
  /** Subscribe to text pushed from main (hotkeys, tray). */
  onReadText(callback: (payload: ReadTextPayload) => void): void;
  /** Subscribe to stop requests (hotkey, tray). */
  onStop(callback: () => void): void;
  /** Report playback state changes back to main. */
  reportState(state: PlayerStatePayload): void;
  /** Ask main to run a capture flow (same as the hotkeys). */
  captureSelection(): void;
  captureRegion(): void;
  readClipboard(): void;
  /** Open a URL in the system browser. */
  openExternal(url: string): void;
  /** Platform, for showing the right hotkey labels. */
  platform: NodeJS.Platform;
}

/** API exposed to the overlay window via contextBridge. */
export interface OverlayBridge {
  complete(rect: RegionRect): void;
  cancel(): void;
}
