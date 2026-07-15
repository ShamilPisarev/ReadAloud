# Read Aloud

A lightweight browser extension for listening to web pages with natural voices, reliable word highlighting, and precise playback controls.

## Features

- Start reading a page, a selection, pasted text, or exactly where you double-click
- Follow along with sentence and word highlighting
- Choose from browser voices, Chrome TTS voices, or 28 local Kokoro voices
- Change speed, pitch, and volume while listening
- Pause, resume, and move between sections
- Keep Kokoro speech local after its one-time model download

Kokoro runs in the browser through WebGPU when the GPU supports it, falling back to WebAssembly. The model is downloaded from Hugging Face the first time you select a Kokoro voice — the popup shows download progress — then stored in the browser cache. Selecting a Kokoro voice also warms the model in the background so playback starts faster.

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

## Privacy

Read Aloud does not require an account. Browser voices use the speech engines available on your system. Kokoro synthesis runs locally in the extension after its model files have been downloaded and cached.
