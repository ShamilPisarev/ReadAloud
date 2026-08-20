import { extract, extractArticle, extractFallback } from '../lib/text/extractor';
import { chunkAtOffset, createChunks } from '../lib/text/chunker';
import { HighlightManager }  from '../lib/text/highlighter';
import { loadSettings, saveSettings } from '../lib/storage';
import { ReadingToolbar } from './toolbar';
import type {
  BackgroundMessage,
  BackgroundResponse,
  ContentScriptMessage,
  ContentScriptResponse,
  PlayerStatePayload,
} from '../lib/messages';
import type { Chunk, TextNodeEntry } from '../lib/text/types';

// ---------------------------------------------------------------------------
// Injection guard — chrome.scripting.executeScript runs this file every time.
// Without the guard, duplicate listeners accumulate causing double-click and
// play-after-stop bugs.
// ---------------------------------------------------------------------------
const GUARD_KEY = '__readAloudContentActive';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(window as any)[GUARD_KEY]) {
  (window as any)[GUARD_KEY] = true;
  bootstrapContentScript();
}

function bootstrapContentScript(): void {

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const highlighter = new HighlightManager();

/** Last extraction result — retained so highlight/scroll messages can
 *  reference the nodeMap without re-extracting. */
let lastNodeMap: TextNodeEntry[] = [];
let lastChunks:  Chunk[]         = [];
let playerState: PlayerStatePayload = {
  status: 'idle',
  chunkIndex: 0,
  totalChunks: 0,
  errorMessage: null,
  modelProgress: null,
  voices: [],
};
let popupVisible = false;
let extensionEnabled = false;
let toolbar: ReadingToolbar | null = null;
let toolbarInitPromise: Promise<void> | null = null;
let dblClickAttached = false;
let lastManualScrollAt = 0;
let wordScheduleTimer: number | null = null;

const MANUAL_SCROLL_SUPPRESS_MS = 8_000;

window.addEventListener('wheel', markManualScroll, { passive: true, capture: true });
window.addEventListener('touchmove', markManualScroll, { passive: true, capture: true });
window.addEventListener('keydown', markKeyboardScroll, true);

void initContentUi();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentScriptResponse) => void,
  ) => {
    const msg = message as Record<string, unknown>;

    // Ping — used by popup/player to check if content script is injected
    if (msg.type === 'PING') {
      sendResponse({ ok: true, source: 'article', text: '', chunks: [] });
      return false;
    }

    // State update from background (pushed via chrome.tabs.sendMessage)
    if (msg.type === 'STATE_UPDATE' && msg.state) {
      playerState = msg.state as PlayerStatePayload;
      void applyStateToUi();
      return false;
    }

    // Extension enabled/disabled toggle from popup
    if (msg.type === 'SET_ENABLED') {
      extensionEnabled = msg.enabled as boolean;
      if (!extensionEnabled) {
        // Immediately tear down all interaction
        popupVisible = false;
        highlighter.clear();
        clearWordSchedule();
        if (dblClickAttached) {
          document.removeEventListener('dblclick', handleDoubleClick, true);
          dblClickAttached = false;
        }
        toolbar?.applyState({ ...playerState, status: 'idle' });
      }
      sendResponse({ ok: true, source: 'article', text: '', chunks: [] });
      return false;
    }

    const csMsg = message as ContentScriptMessage;

    switch (csMsg.type) {
      case 'EXTRACT_TEXT':
        handleExtract(sendResponse, csMsg.fromSelectionStart ?? false, csMsg.chunkChars);
        return true; // keep the channel open for the async response

      case 'HIGHLIGHT_CHUNK':
        clearWordSchedule();
        handleHighlight(csMsg.chunkIndex, csMsg.scroll, sendResponse);
        return false; // synchronous response

      case 'HIGHLIGHT_WORD':
        clearWordSchedule();
        try {
          highlighter.highlightWord(csMsg.charIndex, csMsg.charLength);
        } catch {
          // Highlighting should never be allowed to interrupt playback.
        }
        sendResponse({ ok: true, source: 'article', text: '', chunks: [] });
        return false;

      case 'HIGHLIGHT_WORD_SCHEDULE':
        startWordSchedule(csMsg.words, csMsg.durationMs);
        sendResponse({ ok: true, source: 'article', text: '', chunks: [] });
        return false;

      case 'POPUP_VISIBILITY':
        popupVisible = csMsg.open;
        void applyStateToUi();
        sendResponse({ ok: true, source: 'article', text: '', chunks: [] });
        return false;

      case 'CLEAR_HIGHLIGHT':
        clearWordSchedule();
        highlighter.clear();
        return false;
    }
  },
);

function startWordSchedule(
  words: Array<{ charIndex: number; charLength: number; atMs: number }>,
  durationMs: number,
): void {
  clearWordSchedule();
  if (words.length === 0 || durationMs <= 0) return;

  let elapsedMs = 0;
  let lastTickAt = performance.now();
  let lastIndex = -1;
  const tick = (): void => {
    const now = performance.now();
    if (playerState.status === 'playing') elapsedMs += now - lastTickAt;
    lastTickAt = now;

    // Advance to the last word whose scheduled start has passed.
    let index = Math.max(0, lastIndex);
    while (index + 1 < words.length && (words[index + 1]?.atMs ?? 0) <= elapsedMs) {
      index++;
    }
    if (index !== lastIndex) {
      lastIndex = index;
      const word = words[index];
      if (word) {
        try {
          highlighter.highlightWord(word.charIndex, word.charLength);
        } catch {
          // Page mutations must not interrupt playback or the schedule.
        }
      }
    }

    if (elapsedMs >= durationMs) clearWordSchedule();
  };

  tick();
  wordScheduleTimer = window.setInterval(tick, 50);
}

function clearWordSchedule(): void {
  if (wordScheduleTimer === null) return;
  window.clearInterval(wordScheduleTimer);
  wordScheduleTimer = null;
}

async function initContentUi(): Promise<void> {
  // Load the enabled state from storage
  const settings = await loadSettings().catch(() => null);
  extensionEnabled = settings?.enabled ?? false;

  const state = await requestState();
  if (state) {
    playerState = state;
    await applyStateToUi();
  }
}

async function ensureToolbar(): Promise<ReadingToolbar> {
  if (toolbar) return toolbar;
  if (!toolbarInitPromise) {
    toolbar = new ReadingToolbar({
      onPlay: () => { void startPlaybackFromToolbar(); },
      onPause: () => { void sendPlaybackCommand('PAUSE'); },
      onResume: () => { void sendPlaybackCommand('RESUME'); },
      onStop: () => { void sendPlaybackCommand('STOP'); },
      onRate: (rate: number) => {
        void saveSettings({ rate });
        chrome.runtime.sendMessage({ type: 'SET_RATE', rate }).catch(() => undefined);
      },
      onVoice: (voiceId: string) => {
        void saveSettings({ voiceId });
        chrome.runtime.sendMessage({ type: 'SET_VOICE', voiceId }).catch(() => undefined);
      },
      onDismiss: () => undefined,
    });
    toolbarInitPromise = toolbar.init()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        toolbarInitPromise = null;
      });
  }

  if (toolbarInitPromise) {
    await toolbarInitPromise;
  }

  return toolbar as ReadingToolbar;
}

async function applyStateToUi(): Promise<void> {
  updateInteractionState();

  if (!extensionEnabled) {
    toolbar?.applyState({ ...playerState, status: 'idle' });
    return;
  }

  const shouldShowToolbar = playerState.status === 'loading' || playerState.status === 'playing' || playerState.status === 'paused';
  if (!shouldShowToolbar) {
    toolbar?.applyState(playerState);
    return;
  }

  const instance = await ensureToolbar();
  const settings = await loadSettings().catch(() => null);
  if (settings) {
    instance.applySettings(settings);
  }
  instance.applyState(playerState);
}

function updateInteractionState(): void {
  // Double-click is only allowed when the extension is enabled AND
  // (the popup is open OR playback is active)
  const wantDblClick = extensionEnabled &&
    (popupVisible || playerState.status === 'loading' || playerState.status === 'playing');
  if (wantDblClick && !dblClickAttached) {
    document.addEventListener('dblclick', handleDoubleClick, true);
    dblClickAttached = true;
  } else if (!wantDblClick && dblClickAttached) {
    document.removeEventListener('dblclick', handleDoubleClick, true);
    dblClickAttached = false;
  }
}

async function requestState(): Promise<PlayerStatePayload | null> {
  const response = await chrome.runtime
    .sendMessage<BackgroundMessage, BackgroundResponse>({ type: 'GET_STATE' })
    .catch(() => null);
  return response && response.ok ? response.state : null;
}

async function sendPlaybackCommand(
  command: 'PLAY' | 'PAUSE' | 'RESUME' | 'STOP',
  extra?: { trigger?: 'selection' | 'page' | 'paste' | 'from-here'; pasteText?: string },
): Promise<void> {
  await chrome.runtime.sendMessage<BackgroundMessage, BackgroundResponse>({
    type: 'PLAYBACK_COMMAND',
    command,
    trigger: extra?.trigger,
    pasteText: extra?.pasteText,
  }).catch(() => undefined);
}

async function startPlaybackFromToolbar(): Promise<void> {
  if (playerState.status === 'paused') {
    await sendPlaybackCommand('RESUME');
    return;
  }
  const selection = window.getSelection()?.toString().trim() ?? '';
  await sendPlaybackCommand('PLAY', {
    trigger: selection ? 'selection' : 'page',
  });
}

function handleDoubleClick(event: MouseEvent): void {
  if (!extensionEnabled) return;
  if (toolbar?.isEventInside(event.target)) return;
  if (!popupVisible && playerState.status !== 'playing' && playerState.status !== 'loading') return;

  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) {
    return;
  }

  // Let the browser finish updating the selection created by the double-click.
  setTimeout(() => {
    const selection = window.getSelection()?.toString().trim() ?? '';
    if (!selection) return;
    toolbar?.reveal();
    void sendPlaybackCommand('PLAY', { trigger: 'from-here' });
  }, 0);
}

function markManualScroll(): void {
  lastManualScrollAt = Date.now();
}

function markKeyboardScroll(event: KeyboardEvent): void {
  const scrollKeys = new Set([
    'ArrowDown',
    'ArrowUp',
    'PageDown',
    'PageUp',
    'Home',
    'End',
    ' ',
  ]);
  if (scrollKeys.has(event.key)) {
    markManualScroll();
  }
}

function shouldAutoScroll(): boolean {
  return Date.now() - lastManualScrollAt > MANUAL_SCROLL_SUPPRESS_MS;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleExtract(
  sendResponse: (r: ContentScriptResponse) => void,
  fromSelectionStart: boolean,
  chunkChars?: number,
): void {
  try {
    // For "read from here": always extract the full page/article — never
    // just the selection — so we read to end-of-page from the anchor point.
    const result = fromSelectionStart
      ? (extractArticle() ?? extractFallback())
      : extract();

    lastNodeMap = result.nodeMap;
    lastChunks  = createChunks(result.text, chunkChars);

    let startChunkIndex: number | undefined;
    if (fromSelectionStart) {
      const startOffset = findSelectionStartOffset(lastNodeMap, result.text);
      const startChunk = startOffset === null
        ? undefined
        : chunkAtOffset(lastChunks, startOffset);

      if (startChunk && startOffset !== null) {
        // Keep the original chunk index (and therefore overall progress), but
        // trim its spoken text so playback begins at the selected word rather
        // than at the start of a multi-sentence chunk.
        lastChunks[startChunk.index] = {
          ...startChunk,
          text: result.text.slice(startOffset, startChunk.endOffset),
          startOffset,
        };
        startChunkIndex = startChunk.index;
      } else {
        startChunkIndex = 0;
      }
    }

    // NodeMap contains live DOM nodes which cannot be serialised across
    // the message boundary — only send the plain-data fields.
    sendResponse({
      ok:     true,
      source: result.source,
      text:   result.text,
      chunks: lastChunks,
      startChunkIndex,
    });
  } catch (err) {
    sendResponse({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Find the exact character offset of the current browser selection within the
 * already-extracted flat text string.
 */
function findSelectionStartOffset(
  nodeMap:       TextNodeEntry[],
  extractedText: string,
): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || extractedText.length === 0) return null;

  const range      = sel.getRangeAt(0);
  const anchor     = range.startContainer;
  const anchorOff  = range.startOffset;

  if (anchor.nodeType === Node.TEXT_NODE) {
    const entry = nodeMap.find(e => e.node === anchor);
    if (entry) {
      let offset = entry.start + Math.min(anchorOff, entry.end - entry.start);
      while (offset < extractedText.length && /\s/.test(extractedText[offset] ?? '')) {
        offset++;
      }
      return offset < extractedText.length ? offset : null;
    }
  }

  let rawText = '';
  if (anchor.nodeType === Node.TEXT_NODE) {
    rawText = ((anchor as Text).textContent ?? '').slice(anchorOff);
  } else if (anchor.nodeType === Node.ELEMENT_NODE) {
    rawText = (anchor as Element).textContent ?? '';
  }

  rawText = rawText.trim();
  if (rawText.length < 2) return null;

  const { text: normText, sourceOffsets } = normaliseWithSourceOffsets(extractedText);

  for (const len of [80, 40, 15]) {
    if (rawText.length < len / 2) continue;
    const needle = normaliseText(rawText.slice(0, Math.min(len, rawText.length)));
    if (needle.length < 4) continue;

    const pos = normText.indexOf(needle);
    if (pos === -1) continue;

    return sourceOffsets[pos] ?? null;
  }

  return null;
}

function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Collapse whitespace while retaining a map back to offsets in the source.
 * This keeps the fallback search accurate even when extraction inserted
 * paragraph newlines that are absent from the clicked DOM node's text.
 */
function normaliseWithSourceOffsets(source: string): {
  text: string;
  sourceOffsets: number[];
} {
  let text = '';
  const sourceOffsets: number[] = [];
  let pendingWhitespaceOffset: number | null = null;

  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? '';
    if (/\s/.test(char)) {
      if (text.length > 0 && pendingWhitespaceOffset === null) {
        pendingWhitespaceOffset = index;
      }
      continue;
    }

    if (pendingWhitespaceOffset !== null) {
      text += ' ';
      sourceOffsets.push(pendingWhitespaceOffset);
      pendingWhitespaceOffset = null;
    }

    text += char;
    sourceOffsets.push(index);
  }

  return { text, sourceOffsets };
}

function handleHighlight(
  chunkIndex: number,
  scroll: boolean,
  sendResponse: (r: ContentScriptResponse) => void,
): void {
  const chunk = lastChunks[chunkIndex];
  if (!chunk) {
    sendResponse({ ok: false, error: `No chunk at index ${chunkIndex}` });
    return;
  }

  try {
    // Manual scrolling should pause only automatic scrolling. The current
    // text must remain highlighted so the visual position never goes stale.
    highlighter.highlight(lastNodeMap, chunk);
    if (scroll && shouldAutoScroll()) {
      highlighter.scrollTo(lastNodeMap, chunk, false);
    }
  } catch {
    // Keep audio running even if the page mutates under our stored DOM ranges.
  }

  sendResponse({
    ok:     true,
    source: 'article',
    text:   chunk.text,
    chunks: lastChunks,
  });
}

} // end bootstrapContentScript
