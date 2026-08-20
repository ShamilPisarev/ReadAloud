# Read Aloud

A lightweight browser extension for listening to web pages with natural voices, reliable word highlighting, and precise playback controls — plus a desktop app (`desktop/`) that reads text aloud from **any** application on Windows and macOS.

## Features

- Start reading a page, a selection, pasted text, or exactly where you double-click
- Follow along with sentence and word highlighting
- Choose from browser voices, Chrome TTS voices, 28 local Kokoro voices, or 36 Flux cloud voices
- Change speed, pitch, and volume while listening
- Pause, resume, and move between sections
- Keep Kokoro speech local after its one-time model download

Kokoro runs in the browser through WebGPU when the GPU supports it, falling back to WebAssembly. The model is downloaded from Hugging Face the first time you select a Kokoro voice — the popup shows download progress — then stored in the browser cache. Selecting a Kokoro voice also warms the model in the background so playback starts faster.

Flux voices are synthesized by Deepgram Flux through [OpenRouter](https://openrouter.ai)'s free `deepgram/flux-tts:free` endpoint. Select a Flux voice in the popup and paste an OpenRouter API key (create one at [openrouter.ai/keys](https://openrouter.ai/keys)) — the key is stored in `chrome.storage.local` and never syncs off the device. Free-tier requests are rate limited by OpenRouter.

## Install locally

1. Install [Node.js](https://nodejs.org/).
2. Run:

   ```bash
   npm install
   npm run build
   ```

3. Open your browser's extensions page.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select this project folder.

The extension manifest loads the compiled files from `dist/`.

## Development

```bash
npm run typecheck
npm run build
npm run watch
```

Integration tests for the OpenRouter engine run against a live browser via CDP:

```bash
node .tools/test-openrouter.mjs 9232 [optional-real-api-key]
```

## Desktop app

`desktop/` contains an Electron app that reads text from anywhere on screen, not just the browser. It reuses the extension's chunker and speech engines (system voices + Flux cloud voices).

- **Ctrl/Cmd+Alt+R** — read the text currently selected in any app (simulated copy; the previous clipboard text is restored)
- **Ctrl/Cmd+Alt+C** — read the clipboard
- **Ctrl/Cmd+Alt+S** — drag a rectangle anywhere on screen; the text inside is OCR'd (Tesseract, local) and read aloud
- **Ctrl/Cmd+Alt+X** — stop

The app lives in the tray; the player window shows the captured text with live chunk/word highlighting.

```bash
cd desktop
npm install
npm start          # build + run
npm run smoke      # headless end-to-end playback test
npm run package    # build installers via electron-builder
```

On macOS the selection hotkey needs the Accessibility permission (System Settings → Privacy & Security) the first time, and screen capture needs the Screen Recording permission. The English OCR model (~2 MB) downloads on first use and is cached in the app's user-data directory.

## Privacy

Read Aloud does not require an account. Browser voices use the speech engines available on your system. Kokoro synthesis runs locally in the extension after its model files have been downloaded and cached. Flux voices send the text being read to OpenRouter for synthesis — they are opt-in and never auto-selected. The desktop app's OCR runs entirely locally.
