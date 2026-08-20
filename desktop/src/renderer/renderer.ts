/**
 * Player window — owns text chunking, the speech engines, and highlighting.
 * The speech engines and chunker are the exact same modules the browser
 * extension uses (../../../src/lib), bundled here by esbuild.
 */

import { SpeechSynthesisEngine } from '../../../src/lib/speech/speech-synthesis-engine';
import { OpenRouterEngine, OPENROUTER_CHUNK_CHARS } from '../../../src/lib/speech/openrouter-engine';
import { pickBestVoice, isNoveltyVoice } from '../../../src/lib/speech/voice-ranking';
import { createChunks, chunkAtOffset } from '../../../src/lib/text/chunker';
import type { Voice }            from '../../../src/lib/speech/types';
import type { Chunk }            from '../../../src/lib/text/types';
import type { PlayerBridge, PlayerStatus, ReadTextPayload } from '../shared/ipc';

declare global {
  interface Window { readAloud: PlayerBridge }
}

const bridge = window.readAloud;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

const statusBadge   = $<HTMLSpanElement>('status-badge');
const textView      = $<HTMLDivElement>('text-view');
const btnPlay       = $<HTMLButtonElement>('btn-play');
const btnPause      = $<HTMLButtonElement>('btn-pause');
const btnStop       = $<HTMLButtonElement>('btn-stop');
const progressLabel = $<HTMLSpanElement>('progress-label');
const voiceSelect   = $<HTMLSelectElement>('voice-select');
const keyRow        = $<HTMLDivElement>('openrouter-key-row');
const keyInput      = $<HTMLInputElement>('openrouter-key');
const keyLink       = $<HTMLAnchorElement>('key-link');
const rangeRate     = $<HTMLInputElement>('range-rate');
const rangeVolume   = $<HTMLInputElement>('range-volume');
const valRate       = $<HTMLSpanElement>('val-rate');
const valVolume     = $<HTMLSpanElement>('val-volume');
const errorBanner   = $<HTMLDivElement>('error-banner');

// ---------------------------------------------------------------------------
// Settings (localStorage)
// ---------------------------------------------------------------------------

interface Settings {
  voiceId: string;
  rate: number;
  volume: number;
  apiKey: string;
}

const SETTINGS_KEY = 'readAloudDesktopSettings';

function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return { voiceId: '', rate: 1, volume: 1, apiKey: '', ...stored };
  } catch {
    return { voiceId: '', rate: 1, volume: 1, apiKey: '' };
  }
}

const settings = loadSettings();

function persistSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

const systemEngine     = new SpeechSynthesisEngine(window.speechSynthesis);
const openRouterEngine = new OpenRouterEngine();

type Engine = typeof systemEngine | typeof openRouterEngine;

function engineForVoice(voiceId: string): Engine {
  return voiceId.startsWith('openrouter:') ? openRouterEngine : systemEngine;
}

let activeEngine: Engine = systemEngine;

for (const engine of [systemEngine, openRouterEngine]) {
  engine.onWordBoundary = (charIndex, charLength) => {
    if (engine === activeEngine && status === 'playing') {
      // Boundaries are relative to the (possibly sliced) text handed to the
      // engine; map back to full-chunk coordinates.
      highlightWord(charIndex + speakOffsetInChunk, charLength);
    }
  };
}

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------

let status: PlayerStatus = 'idle';
let chunks: Chunk[] = [];
let chunkIndex = 0;
let generation = 0;
/** Set by double-click: start speaking the next chunk at this text offset. */
let pendingChunkOffset = 0;
/** Offset the current utterance was sliced at, for word-highlight mapping. */
let speakOffsetInChunk = 0;

function setStatus(next: PlayerStatus, errorMessage: string | null = null): void {
  status = next;
  const labels: Record<PlayerStatus, string> = {
    idle: 'Ready', loading: 'Preparing…', playing: 'Reading',
    paused: 'Paused', error: 'Needs attention',
  };
  statusBadge.textContent = labels[next];
  statusBadge.className = `badge badge--${next}`;

  btnPlay.disabled  = next === 'playing' || next === 'loading';
  btnPause.disabled = next !== 'playing';
  btnStop.disabled  = next === 'idle' || next === 'error';

  progressLabel.textContent = chunks.length > 0 && next !== 'idle' && next !== 'error'
    ? `Part ${chunkIndex + 1} of ${chunks.length}`
    : '—';

  if (errorMessage) showError(errorMessage);
  else clearError();

  bridge.reportState({ status: next, errorMessage });
}

function startSession(text: string): void {
  stopPlayback();
  // Cloud voices batch more text per chunk: one API request per chunk, and
  // the OpenRouter free tier caps requests per day.
  const chunkChars = resolveVoiceId().startsWith('openrouter:')
    ? OPENROUTER_CHUNK_CHARS
    : undefined;
  chunks = createChunks(text, chunkChars);
  chunkIndex = 0;
  renderTextView();
  if (chunks.length === 0) {
    setStatus('error', 'There is no readable text.');
    return;
  }
  setStatus('playing');
  playCurrentChunk();
}

function playCurrentChunk(): void {
  const chunk = chunks[chunkIndex];
  if (!chunk || status !== 'playing') return;

  highlightChunk(chunkIndex);
  setStatus('playing');

  const voiceId = resolveVoiceId();
  const nextEngine = engineForVoice(voiceId);
  if (nextEngine !== activeEngine) {
    activeEngine.stop();
    activeEngine = nextEngine;
  }
  if (activeEngine === openRouterEngine) {
    openRouterEngine.apiKey = settings.apiKey;
  }

  // "Read from here": speak only from the double-clicked word onward.
  speakOffsetInChunk = Math.min(pendingChunkOffset, chunk.text.length);
  pendingChunkOffset = 0;

  const gen = ++generation;
  activeEngine.speak(chunk.text.slice(speakOffsetInChunk), {
    voiceId,
    rate:   settings.rate,
    volume: settings.volume,
    prefetchText: activeEngine === openRouterEngine
      ? chunks[chunkIndex + 1]?.text
      : undefined,
  }).then(() => {
    if (gen === generation) onChunkDone(true);
  }).catch((err: unknown) => {
    if (gen === generation) {
      onChunkDone(false, err instanceof Error ? err.message : String(err));
    }
  });
}

function onChunkDone(ok: boolean, error?: string): void {
  if (!ok) {
    setStatus('error', error ?? 'Something went wrong while reading.');
    return;
  }
  if (status !== 'playing') return;

  chunkIndex++;
  if (chunkIndex >= chunks.length) {
    finishSession();
    return;
  }
  playCurrentChunk();
}

function finishSession(): void {
  clearHighlights();
  chunkIndex = 0;
  setStatus('idle');
}

function stopPlayback(): void {
  ++generation;
  systemEngine.stop();
  openRouterEngine.stop();
  clearHighlights();
  chunkIndex = 0;
  pendingChunkOffset = 0;
  speakOffsetInChunk = 0;
  if (status !== 'idle') setStatus('idle');
}

/** Jump playback to `offsetInChunk` within chunk `index` (snapped to the word start). */
function readFrom(index: number, offsetInChunk: number): void {
  const chunk = chunks[index];
  if (!chunk) return;

  ++generation;
  systemEngine.stop();
  openRouterEngine.stop();
  chunkIndex = index;

  const text = chunk.text;
  let start = Math.max(0, Math.min(offsetInChunk, Math.max(0, text.length - 1)));
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
  pendingChunkOffset = start;

  (window as { __lastReadFrom?: { index: number; offset: number } }).__lastReadFrom =
    { index, offset: start };
  setStatus('playing');
  playCurrentChunk();
}

function pausePlayback(): void {
  if (status !== 'playing') return;
  activeEngine.pause();
  setStatus('paused');
}

function resumePlayback(): void {
  if (status !== 'paused') return;
  activeEngine.resume();
  setStatus('playing');
}

/**
 * The saved voice when it exists, otherwise the best-ranked system voice.
 * Never auto-selects a cloud voice: those need an API key, so they are an
 * explicit opt-in ('' lets the system engine use its platform default).
 */
function resolveVoiceId(): string {
  if (settings.voiceId) return settings.voiceId;
  const systemVoices = allVoices.filter(voice => voice.engine === 'speech-synthesis');
  const best = pickBestVoice(systemVoices, navigator.language);
  return best?.id ?? '';
}

// ---------------------------------------------------------------------------
// Text view + highlighting
// ---------------------------------------------------------------------------

function renderTextView(): void {
  textView.textContent = '';
  chunks.forEach((chunk, index) => {
    if (index > 0) textView.appendChild(document.createTextNode('\n'));
    const span = document.createElement('span');
    span.dataset['chunk'] = String(index);
    span.textContent = chunk.text;
    textView.appendChild(span);
  });
}

function chunkElement(index: number): HTMLSpanElement | null {
  return textView.querySelector(`span[data-chunk="${index}"]`);
}

function highlightChunk(index: number): void {
  clearHighlights();
  const el = chunkElement(index);
  if (el) {
    el.classList.add('chunk--active');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function highlightWord(charIndex: number, charLength: number): void {
  const el = chunkElement(chunkIndex);
  const chunk = chunks[chunkIndex];
  if (!el || !chunk) return;

  const text = chunk.text;
  const start = Math.max(0, Math.min(charIndex, text.length));
  const end = Math.max(start, Math.min(charIndex + charLength, text.length));

  el.textContent = '';
  el.appendChild(document.createTextNode(text.slice(0, start)));
  const word = document.createElement('span');
  word.className = 'word--active';
  word.textContent = text.slice(start, end);
  el.appendChild(word);
  el.appendChild(document.createTextNode(text.slice(end)));
}

function clearHighlights(): void {
  for (const el of Array.from(textView.querySelectorAll('span[data-chunk]'))) {
    const index = Number((el as HTMLElement).dataset['chunk']);
    el.classList.remove('chunk--active');
    // Flatten any word-highlight markup back to plain text.
    const chunk = chunks[index];
    if (chunk && el.childNodes.length > 1) el.textContent = chunk.text;
  }
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * The platform hands us every installed voice — ~180 on macOS, spanning 40+
 * languages and Apple's novelty tier. Narrow that to what this user can
 * actually use: their own languages, real voices only.
 *
 * Kept deliberately permissive at the edges — the currently selected voice
 * always survives so a saved choice can never vanish from the picker, and an
 * over-aggressive filter falls back to the full list rather than showing none.
 * Cloud (Flux) voices are never filtered; they are a short, curated list.
 */
function shortlistSystemVoices(voices: Voice[]): Voice[] {
  // navigator.languages is the system's ordered language preference,
  // e.g. ['en-US', 'de-DE'] -> keep every en-* and de-* voice.
  const wanted = new Set(
    (navigator.languages.length > 0 ? navigator.languages : [navigator.language])
      .map(tag => tag.toLowerCase().split('-')[0])
      .filter((prefix): prefix is string => Boolean(prefix)),
  );
  // English is always offered regardless of system locale: the Flux and Kokoro
  // voice sets are English-only, and a machine localised to another language
  // would otherwise lose every English voice it has installed.
  wanted.add('en');

  const shortlist = voices.filter(voice => {
    if (voice.id === settings.voiceId) return true;
    if (isNoveltyVoice(voice.name)) return false;
    const prefix = voice.lang.toLowerCase().split('-')[0];
    return prefix !== undefined && wanted.has(prefix);
  });

  return shortlist.length > 0 ? shortlist : voices;
}

let allVoices: Voice[] = [];

async function populateVoices(): Promise<void> {
  const [systemVoices, fluxVoices] = await Promise.all([
    // Rank the platform's ~180 voices against this machine's locale, so the
    // handful in the user's own language (and any Premium/Enhanced ones among
    // them) sort above the 40+ other languages instead of being buried.
    systemEngine.getVoices(navigator.language).catch(() => [] as Voice[]),
    openRouterEngine.getVoices(),
  ]);
  allVoices = [...systemVoices, ...fluxVoices];
  const shownSystemVoices = shortlistSystemVoices(systemVoices);
  console.log(
    `[voices] system: ${systemVoices.length} (${shownSystemVoices.length} shown),`
    + ` flux: ${fluxVoices.length}`,
  );

  voiceSelect.textContent = '';
  const addGroup = (label: string, voices: Voice[]): void => {
    if (voices.length === 0) return;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.name} (${voice.lang})${voice.local ? '' : ' ☁'}`;
      group.appendChild(option);
    }
    voiceSelect.appendChild(group);
  };

  addGroup('System voices', shownSystemVoices);
  addGroup('Flux cloud AI — needs OpenRouter key', fluxVoices);

  const preferred = settings.voiceId || resolveVoiceId();
  if (Array.from(voiceSelect.options).some(option => option.value === preferred)) {
    voiceSelect.value = preferred;
  }
  updateKeyRowVisibility();
}

function updateKeyRowVisibility(): void {
  keyRow.classList.toggle('hidden', !voiceSelect.value.startsWith('openrouter:'));
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function clearError(): void {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

btnPlay.addEventListener('click', () => {
  if (status === 'paused') {
    resumePlayback();
    return;
  }
  const text = (textView.textContent ?? '').trim();
  if (!text) {
    showError('Capture some text first, or type it above.');
    return;
  }
  startSession(text);
});

btnPause.addEventListener('click', pausePlayback);
btnStop.addEventListener('click', stopPlayback);

$<HTMLButtonElement>('btn-capture-selection').addEventListener('click', () => bridge.captureSelection());
$<HTMLButtonElement>('btn-capture-clipboard').addEventListener('click', () => bridge.readClipboard());
$<HTMLButtonElement>('btn-capture-region').addEventListener('click', () => bridge.captureRegion());

voiceSelect.addEventListener('change', () => {
  settings.voiceId = voiceSelect.value;
  persistSettings();
  updateKeyRowVisibility();
  if (status === 'playing') {
    // Restart the current part with the new voice.
    ++generation;
    systemEngine.stop();
    openRouterEngine.stop();
    playCurrentChunk();
  }
});

const keyStatus = $<HTMLSpanElement>('openrouter-key-status');
let keyStatusTimer: ReturnType<typeof setTimeout> | undefined;

keyInput.addEventListener('input', () => {
  settings.apiKey = keyInput.value.trim();
  persistSettings();
  keyStatus.textContent = settings.apiKey ? 'Saved ✓' : '';
  clearTimeout(keyStatusTimer);
  keyStatusTimer = setTimeout(() => { keyStatus.textContent = ''; }, 2_500);
});

keyLink.addEventListener('click', event => {
  event.preventDefault();
  bridge.openExternal('https://openrouter.ai/keys');
});

rangeRate.addEventListener('input', () => {
  const rate = parseFloat(rangeRate.value);
  valRate.textContent = `${rate.toFixed(2)}×`;
  settings.rate = rate;
  persistSettings();
  if (status === 'playing') {
    const gen = ++generation;
    activeEngine.setRate(rate)
      .then(() => { if (gen === generation) onChunkDone(true); })
      .catch((err: unknown) => {
        if (gen === generation) {
          onChunkDone(false, err instanceof Error ? err.message : String(err));
        }
      });
  }
});

rangeVolume.addEventListener('input', () => {
  const volume = parseFloat(rangeVolume.value);
  valVolume.textContent = `${Math.round(volume * 100)}%`;
  settings.volume = volume;
  persistSettings();
});

// Double-click a word to start (or jump) reading from that point.
textView.addEventListener('dblclick', event => {
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !textView.contains(caret.startContainer)) return;
  const node = caret.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const chunkEl = element?.closest('span[data-chunk]');

  if (chunkEl instanceof HTMLElement) {
    // Text is already chunked and rendered — map the caret to an offset
    // within the chunk (the span may hold word-highlight sub-nodes).
    const index = Number(chunkEl.dataset['chunk']);
    let offset = caret.startOffset;
    for (const child of Array.from(chunkEl.childNodes)) {
      if (child === node || child.contains(node)) break;
      offset += child.textContent?.length ?? 0;
    }
    readFrom(index, offset);
    return;
  }

  // Raw typed/pasted text that has not been chunked yet: compute the global
  // offset in the text, chunk it, then start from the containing chunk.
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = textView.textContent ?? '';
  if (!text.trim()) return;

  let globalOffset = caret.startOffset;
  const walker = document.createTreeWalker(textView, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode === node) break;
    globalOffset += walker.currentNode.textContent?.length ?? 0;
  }

  stopPlayback();
  const chunkChars = resolveVoiceId().startsWith('openrouter:')
    ? OPENROUTER_CHUNK_CHARS
    : undefined;
  chunks = createChunks(text, chunkChars);
  renderTextView();
  if (chunks.length === 0) return;
  const target = chunkAtOffset(chunks, globalOffset) ?? chunks[chunks.length - 1]!;
  readFrom(target.index, Math.max(0, globalOffset - target.startOffset));
});

bridge.onReadText((payload: ReadTextPayload) => {
  startSession(payload.text);
});

bridge.onStop(() => stopPlayback());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applySettingsToUI(): void {
  rangeRate.value = String(settings.rate);
  valRate.textContent = `${settings.rate.toFixed(2)}×`;
  rangeVolume.value = String(settings.volume);
  valVolume.textContent = `${Math.round(settings.volume * 100)}%`;
  keyInput.value = settings.apiKey;

  const isMac = bridge.platform === 'darwin';
  const mod = isMac ? 'Cmd' : 'Ctrl';
  $<HTMLElement>('kbd-selection').textContent = `${mod}+Alt+R`;
  $<HTMLElement>('kbd-clipboard').textContent = `${mod}+Alt+C`;
  $<HTMLElement>('kbd-region').textContent    = `${mod}+Alt+S`;
}

applySettingsToUI();
setStatus('idle');
void populateVoices();
// System voice lists can arrive late on some platforms.
window.speechSynthesis?.addEventListener('voiceschanged', () => void populateVoices(), { once: true });
