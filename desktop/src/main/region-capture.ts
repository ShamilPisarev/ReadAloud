/**
 * Screen-region capture: shows a transparent overlay on EVERY display, lets
 * the user drag a rectangle on whichever screen has the text, then
 * screenshots that region via desktopCapturer. The PNG goes to OCR.
 */

import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import * as path from 'node:path';
import type { RegionRect } from '../shared/ipc';

const MIN_REGION_PX = 8;
const SELECTION_TIMEOUT_MS = 120_000;

let selectionInProgress = false;

/**
 * Resolves with a PNG buffer of the selected region, or null when the user
 * cancelled (Esc / right-click / a selection too small to contain text).
 */
export async function captureScreenRegion(): Promise<Buffer | null> {
  if (selectionInProgress) return null;
  selectionInProgress = true;
  try {
    const selection = await selectRegionAcrossDisplays();
    if (
      !selection ||
      selection.rect.width < MIN_REGION_PX ||
      selection.rect.height < MIN_REGION_PX
    ) {
      return null;
    }

    // Let the overlays fully disappear before grabbing the frame.
    await delay(250);
    return await captureRect(selection.display, selection.rect);
  } finally {
    selectionInProgress = false;
  }
}

/**
 * Screenshot `rect` (in CSS pixels, relative to the display's own top-left)
 * from `display`. Exported separately so --smoke-capture can exercise the
 * multi-monitor matching without an interactive drag.
 */
export async function captureRect(
  display: Electron.Display,
  rect: RegionRect,
): Promise<Buffer> {
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
  });

  // Primary path: match by display_id. Some Windows configurations return
  // sources without display ids — fall back to positional matching against
  // screen.getAllDisplays(), whose order desktopCapturer follows in practice.
  let source = sources.find(s => s.display_id === String(display.id));
  if (!source) {
    const index = screen.getAllDisplays().findIndex(d => d.id === display.id);
    source = sources[index] ?? sources[0];
  }
  if (!source) throw new Error('No screen source available for capture.');

  // Derive the effective scale from the thumbnail we actually received —
  // desktopCapturer fits thumbnails into the requested size, so on mixed-DPI
  // setups the returned dimensions are the only reliable reference.
  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();
  const scaleX = size.width / display.bounds.width;
  const scaleY = size.height / display.bounds.height;

  const cropped = thumbnail.crop({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  });
  return cropped.toPNG();
}

interface RegionSelection {
  display: Electron.Display;
  rect: RegionRect;
}

function selectRegionAcrossDisplays(): Promise<RegionSelection | null> {
  return new Promise(resolve => {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const overlays = new Map<number, { window: BrowserWindow; display: Electron.Display }>();

    for (const display of screen.getAllDisplays()) {
      const window = createOverlayWindow(display);
      void window.loadFile(path.join(__dirname, '../../src/overlay/overlay.html'));
      // Esc goes to the focused overlay — start on the cursor's display.
      if (display.id === cursorDisplay.id) window.focus();
      overlays.set(window.webContents.id, { window, display });
    }

    const finish = (selection: RegionSelection | null): void => {
      clearTimeout(timeout);
      ipcMain.removeListener('overlay-done', onDone);
      ipcMain.removeListener('overlay-cancel', onCancel);
      for (const { window } of overlays.values()) {
        if (!window.isDestroyed()) window.close();
      }
      overlays.clear();
      resolve(selection);
    };

    const onDone = (event: Electron.IpcMainEvent, rect: RegionRect): void => {
      const entry = overlays.get(event.sender.id);
      finish(entry ? { display: entry.display, rect } : null);
    };
    const onCancel = (): void => finish(null);

    ipcMain.on('overlay-done', onDone);
    ipcMain.on('overlay-cancel', onCancel);

    // Safety net: never leave invisible fullscreen overlays behind.
    const timeout = setTimeout(() => finish(null), SELECTION_TIMEOUT_MS);
  });
}

/**
 * Create a transparent fullscreen overlay window covering `display`.
 *
 * On Windows mixed-DPI setups, the BrowserWindow constructor scales bounds
 * with the PRIMARY display's DPI, so a window meant for a monitor with a
 * different scale factor comes out the wrong size (electron#10862). The fix
 * is to re-apply the bounds after creation: the first setBounds moves the
 * window onto the target display (which may itself rescale it), the second
 * fixes the size now that the window uses that display's DPI.
 *
 * Exported for the --smoke-overlay test.
 */
export function createOverlayWindow(display: Electron.Display): BrowserWindow {
  const window = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setBounds(display.bounds);
  window.setBounds(display.bounds);
  window.setAlwaysOnTop(true, 'screen-saver');
  return window;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
