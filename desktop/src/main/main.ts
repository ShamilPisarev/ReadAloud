/**
 * Read Aloud desktop — main process.
 *
 * A tray-resident app that reads text aloud from ANY application:
 *   - Ctrl/Cmd+Alt+R  read the text currently selected (simulated copy)
 *   - Ctrl/Cmd+Alt+C  read the clipboard
 *   - Ctrl/Cmd+Alt+S  drag a rectangle on screen, OCR it, read it
 *   - Ctrl/Cmd+Alt+X  stop reading
 *
 * Synthesis happens in the player window's renderer, which shares the speech
 * engines and text chunker with the ReadAloud browser extension (../src/lib).
 */

import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { captureSelectionText, preloadKeySender, disposeKeySender } from './selection-capture';
import { captureScreenRegion, captureRect, createOverlayWindow } from './region-capture';
import { recognizeText, disposeOcrWorker } from './ocr';
import type { CaptureSource, PlayerStatePayload, ReadTextPayload } from '../shared/ipc';

const APP_ROOT = path.join(__dirname, '../..');

const HOTKEYS: Array<{ accelerator: string; action: () => void; label: string }> = [
  { accelerator: 'CommandOrControl+Alt+R', action: () => void readSelection(), label: 'Read selected text' },
  { accelerator: 'CommandOrControl+Alt+C', action: () => void readClipboard(), label: 'Read clipboard' },
  { accelerator: 'CommandOrControl+Alt+S', action: () => void readScreenRegion(), label: 'Read screen area (OCR)' },
  { accelerator: 'CommandOrControl+Alt+X', action: () => stopPlayback(), label: 'Stop reading' },
];

let playerWindow: BrowserWindow | null = null;
let rendererReady: Promise<void> = Promise.resolve();
let tray: Tray | null = null;
let quitting = false;
let captureBusy = false;
let lastPlayerState: PlayerStatePayload = { status: 'idle', errorMessage: null };

const smokeMode = process.argv.includes('--smoke');
const smokeOcrIndex = process.argv.indexOf('--smoke-ocr');
const screenshotIndex = process.argv.indexOf('--screenshot');

/** Debug trace for smoke runs — stdout can get lost on Windows GUI apps. */
const smokeTracing = smokeMode || smokeOcrIndex !== -1
  || process.argv.includes('--smoke-capture') || process.argv.includes('--smoke-overlay')
  || process.argv.includes('--smoke-dblclick');

function trace(message: string): void {
  console.log(message);
  if (!smokeTracing) return;
  try {
    fs.appendFileSync(path.join(APP_ROOT, 'debug.log'), `${new Date().toISOString()} ${message}\n`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Player window
// ---------------------------------------------------------------------------

function createPlayerWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 380,
    minHeight: 480,
    show: false,
    icon: path.join(APP_ROOT, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist/preload/player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  rendererReady = new Promise(resolve => {
    ipcMain.once('renderer-ready', () => resolve());
  });

  void window.loadFile(path.join(APP_ROOT, 'src/renderer/index.html'));

  // Standard edit context menu — Electron shows none by default, which made
  // right-click → Paste impossible in the text view.
  window.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate([
      { role: 'cut',   enabled: params.editFlags.canCut },
      { role: 'copy',  enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]).popup();
  });

  // Closing the window keeps the app in the tray.
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    playerWindow = null;
  });

  return window;
}

async function ensurePlayerWindow(): Promise<BrowserWindow> {
  if (!playerWindow || playerWindow.isDestroyed()) {
    playerWindow = createPlayerWindow();
  }
  await rendererReady;
  return playerWindow;
}

async function sendToPlayer(text: string, source: CaptureSource): Promise<void> {
  const window = await ensurePlayerWindow();
  const payload: ReadTextPayload = { text, source };
  window.webContents.send('read-text', payload);
  // Surface the player without stealing focus from the app being read.
  if (!window.isVisible()) window.showInactive();
}

function stopPlayback(): void {
  playerWindow?.webContents.send('stop-playback');
}

function showPlayer(): void {
  void ensurePlayerWindow().then(window => {
    window.show();
    window.focus();
  });
}

// ---------------------------------------------------------------------------
// Capture flows
// ---------------------------------------------------------------------------

/** Serialize capture flows: a second hotkey press during one is ignored. */
async function runCapture(flow: () => Promise<void>): Promise<void> {
  if (captureBusy) return;
  captureBusy = true;
  try {
    await flow();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  } finally {
    captureBusy = false;
  }
}

async function readSelection(): Promise<void> {
  await runCapture(async () => {
    const text = await captureSelectionText();
    if (!text) {
      notify('No text selected. Select text in any app, then press the hotkey again.');
      return;
    }
    await sendToPlayer(text, 'selection');
  });
}

async function readClipboard(): Promise<void> {
  await runCapture(async () => {
    const text = clipboard.readText().trim();
    if (!text) {
      notify('The clipboard has no text to read.');
      return;
    }
    await sendToPlayer(text, 'clipboard');
  });
}

async function readScreenRegion(): Promise<void> {
  await runCapture(async () => {
    const png = await captureScreenRegion();
    if (!png) return; // cancelled
    notify('Recognizing text…', true);
    const text = await recognizeText(png);
    if (!text) {
      notify('No readable text found in that screen area.');
      return;
    }
    await sendToPlayer(text, 'ocr');
  });
}

function notify(body: string, silent = false): void {
  console.log(`[read-aloud] ${body}`);
  if (Notification.isSupported()) {
    new Notification({ title: 'Read Aloud', body, silent }).show();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets/tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Read Aloud');

  const hotkeyHint = (accelerator: string): string =>
    accelerator.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open player', click: showPlayer },
    { type: 'separator' },
    ...HOTKEYS.map(({ label, accelerator, action }) => ({
      label: `${label}\t${hotkeyHint(accelerator)}`,
      click: action,
    })),
    { type: 'separator' },
    {
      label: 'Quit Read Aloud',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));

  tray.on('click', showPlayer);
}

// ---------------------------------------------------------------------------
// IPC from the player window
// ---------------------------------------------------------------------------

ipcMain.on('player-state', (_event, state: PlayerStatePayload) => {
  lastPlayerState = state;
  onPlayerStateForSmoke(state);
});
ipcMain.on('capture-selection', () => void readSelection());
ipcMain.on('capture-region', () => void readScreenRegion());
ipcMain.on('read-clipboard', () => void readClipboard());
ipcMain.on('open-external', (_event, url: string) => {
  if (/^https:\/\//.test(url)) void shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Smoke tests (used by CI / agent verification, not end users)
// ---------------------------------------------------------------------------

let smokeSawPlaying = false;

function onPlayerStateForSmoke(state: PlayerStatePayload): void {
  if (!smokeMode) return;
  if (state.status === 'playing') smokeSawPlaying = true;
  if (state.status === 'error') {
    console.log(`SMOKE FAIL: player error: ${state.errorMessage}`);
    app.exit(1);
  }
  if (smokeSawPlaying && state.status === 'idle') {
    console.log('SMOKE PASS: playback completed');
    quitting = true;
    app.quit();
  }
}

async function runSmokeTest(): Promise<void> {
  console.log('SMOKE: sending sample text to player');
  await sendToPlayer(
    'Smoke test. The desktop reader pipeline works end to end.',
    'manual',
  );
  setTimeout(() => {
    console.log(`SMOKE FAIL: timed out (last state: ${lastPlayerState.status})`);
    app.exit(1);
  }, 90_000);
}

/**
 * Verify double-click-to-read-from-here: load a multi-chunk text, dispatch a
 * real dblclick on a word inside chunk 1, and assert playback jumped there.
 */
async function runSmokeDblclick(): Promise<void> {
  const sample = Array(12)
    .fill('Sentence one is about testing. Sentence two continues the thought. Sentence three ends it.')
    .join('\n');
  await sendToPlayer(sample, 'manual');
  await new Promise(resolve => setTimeout(resolve, 1_800));

  const window = await ensurePlayerWindow();
  const dispatched = await window.webContents.executeJavaScript(`(async () => {
    const view = document.getElementById('text-view');
    view.scrollTop = 0;
    await new Promise(resolve => setTimeout(resolve, 120));
    const span = document.querySelector('span[data-chunk="1"]');
    if (!span || !span.firstChild) return 'no-span';
    const range = document.createRange();
    range.setStart(span.firstChild, 12);
    range.setEnd(span.firstChild, 13);
    const rect = range.getBoundingClientRect();
    view.dispatchEvent(new MouseEvent('dblclick', {
      clientX: rect.left + 1,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }));
    return 'dispatched at ' + Math.round(rect.left) + ',' + Math.round(rect.top);
  })()`);
  trace(`SMOKE DBLCLICK: ${dispatched}`);

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await window.webContents.executeJavaScript('window.__lastReadFrom ?? null');
    if (result) {
      const pass = result.index === 1 && lastPlayerState.status === 'playing';
      trace(`SMOKE DBLCLICK: readFrom ${JSON.stringify(result)}, status ${lastPlayerState.status}`);
      trace(pass ? 'SMOKE DBLCLICK PASS' : 'SMOKE DBLCLICK FAIL');
      quitting = true;
      app.exit(pass ? 0 : 1);
      return;
    }
  }
  trace('SMOKE DBLCLICK FAIL: readFrom never fired');
  app.exit(1);
}

async function runScreenshot(outPath: string): Promise<void> {
  const window = await ensurePlayerWindow();
  window.show();
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(outPath, image.toPNG());
  console.log(`SCREENSHOT: ${outPath}`);
  quitting = true;
  app.quit();
}

/**
 * Multi-monitor pipeline test: on EVERY display, open a small window with
 * known text, screenshot that region through the same code the region picker
 * uses, OCR it, and verify the right screen was captured.
 */
async function runSmokeCapture(): Promise<void> {
  const names = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];
  const displays = screen.getAllDisplays();
  trace(`SMOKE CAPTURE: ${displays.length} display(s) detected`);
  let failures = 0;

  for (const [index, display] of displays.entries()) {
    const name = names[index] ?? `NUMBER${index}`;
    const probe = new BrowserWindow({
      x: display.bounds.x + 80,
      y: display.bounds.y + 80,
      width: 560,
      height: 200,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
    await probe.loadURL(
      'data:text/html,<body style="background:%23fff;color:%23000;'
      + `font:bold 44px Arial;margin:0;padding:30px">SCREEN ${name} READS FINE</body>`,
    );
    probe.showInactive();
    await new Promise(resolve => setTimeout(resolve, 700));
    trace(`SMOKE CAPTURE: probe ${index} shown, capturing…`);

    try {
      const png = await captureRect(display, { x: 80, y: 80, width: 560, height: 200 });
      trace(`SMOKE CAPTURE: captured ${png.length} bytes, running OCR…`);
      const text = await recognizeText(png);
      const pass = text.includes(`SCREEN ${name}`);
      if (!pass) failures++;
      const primary = display.id === screen.getPrimaryDisplay().id ? ', primary' : '';
      trace(
        `${pass ? 'PASS' : 'FAIL'} display ${index}`
        + ` (${display.bounds.width}x${display.bounds.height}@${display.scaleFactor}x${primary}):`
        + ` ${JSON.stringify(text)}`,
      );
    } catch (error) {
      failures++;
      trace(`FAIL display ${index}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      probe.destroy();
    }
  }

  await disposeOcrWorker();
  trace(failures === 0 ? 'SMOKE CAPTURE PASS' : `SMOKE CAPTURE FAIL (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
}

/**
 * Verify the region-picker overlay actually covers each display — catches
 * the Windows mixed-DPI bounds bug (a laptop-sized overlay on the ultrawide).
 */
async function runSmokeOverlay(): Promise<void> {
  const displays = screen.getAllDisplays();
  trace(`SMOKE OVERLAY: ${displays.length} display(s)`);
  let failures = 0;

  for (const [index, display] of displays.entries()) {
    const overlay = createOverlayWindow(display);
    await new Promise(resolve => setTimeout(resolve, 600));
    const bounds = overlay.getBounds();
    const expected = display.bounds;
    const pass =
      Math.abs(bounds.x - expected.x) <= 2 &&
      Math.abs(bounds.y - expected.y) <= 2 &&
      Math.abs(bounds.width - expected.width) <= 2 &&
      Math.abs(bounds.height - expected.height) <= 2;
    if (!pass) failures++;
    trace(
      `${pass ? 'PASS' : 'FAIL'} display ${index}@${display.scaleFactor}x:`
      + ` expected ${JSON.stringify(expected)}, got ${JSON.stringify(bounds)}`,
    );
    overlay.destroy();
  }

  trace(failures === 0 ? 'SMOKE OVERLAY PASS' : `SMOKE OVERLAY FAIL (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
}

async function runSmokeOcr(imagePath: string): Promise<void> {
  try {
    const png = fs.readFileSync(imagePath);
    const text = await recognizeText(png);
    console.log(`SMOKE OCR TEXT: ${JSON.stringify(text)}`);
    await disposeOcrWorker();
    app.exit(text.trim() ? 0 : 1);
  } catch (error) {
    console.log(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPlayer);

  void app.whenReady().then(() => {
    trace(`ready, argv: ${JSON.stringify(process.argv.slice(1))}`);
    if (smokeOcrIndex !== -1) {
      const imagePath = process.argv[smokeOcrIndex + 1];
      if (!imagePath) {
        console.log('SMOKE FAIL: --smoke-ocr needs an image path');
        app.exit(1);
        return;
      }
      void runSmokeOcr(imagePath);
      return;
    }

    createTray();
    preloadKeySender();

    for (const { accelerator, action, label } of HOTKEYS) {
      const registered = globalShortcut.register(accelerator, action);
      if (!registered) {
        notify(`The shortcut for "${label}" is taken by another app.`);
      }
    }

    if (smokeMode) {
      void runSmokeTest();
    } else if (process.argv.includes('--smoke-capture')) {
      void runSmokeCapture();
    } else if (process.argv.includes('--smoke-overlay')) {
      void runSmokeOverlay();
    } else if (process.argv.includes('--smoke-dblclick')) {
      void runSmokeDblclick();
    } else if (screenshotIndex !== -1) {
      void runScreenshot(process.argv[screenshotIndex + 1] ?? 'player.png');
    } else {
      showPlayer();
    }
  });

  // Tray app: stay alive when all windows are closed (macOS and Windows).
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('activate', showPlayer);

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    disposeKeySender();
    void disposeOcrWorker();
  });
}
