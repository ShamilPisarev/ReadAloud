/**
 * Player — manages the read-aloud playback lifecycle inside the service worker.
 *
 * Responsibilities:
 *  - Hold the ordered chunk list and current position.
 *  - Drive the offscreen document chunk-by-chunk via messages.
 *  - Handle pause / resume / stop from popup, context menu, or keyboard.
 *  - Emit state snapshots that the service worker broadcasts to the popup.
 *  - Recover from service-worker restarts by persisting minimal state to
 *    chrome.storage.session (tab id + chunk index).
 */

import { loadSettings, saveSettings }  from '../lib/storage';
import { ChromeTtsEngine }            from '../lib/speech/chrome-tts-engine';
import { pickBestVoice, rankVoices }  from '../lib/speech/voice-ranking';
import type { EngineId, Voice }       from '../lib/speech/types';
import type { Chunk }                 from '../lib/text/types';
import type {
  PlayerStatePayload,
  PlayerStatus,
  ContentScriptMessage,
  ContentScriptResponse,
  OffscreenMessage,
} from '../lib/messages';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Resolved once at module load — used by both createDocument and the
// existence check so the URL comparison always matches exactly.
const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/offscreen.html');
const SESSION_KEY   = 'readAloudPlayerSession';

/** ms to wait for voices before giving up and using auto-select */
const VOICE_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Internal state (recreated on service-worker restart)
// ---------------------------------------------------------------------------

export type PlayTrigger = 'selection' | 'page' | 'paste' | 'from-here';

interface PlayerSession {
  tabId:           number;
  chunks:          Chunk[];
  chunkIndex:      number;
  totalChunks:     number;
  pasteText:       string;
  trigger:         PlayTrigger;
}

export type StateChangeCallback = (state: PlayerStatePayload) => void;

// ---------------------------------------------------------------------------
// Player class
// ---------------------------------------------------------------------------

export class Player {
  private session:       PlayerSession | null = null;
  private status:        PlayerStatus         = 'idle';
  private errorMessage:  string | null        = null;
  private cachedVoices:  Voice[]              = [];
  private chromeTtsEngine = new ChromeTtsEngine();
  private activeEngine: EngineId = 'speech-synthesis';
  private playbackGeneration = 0;
  private restartOnResume = false;
  private offscreenReady = false;
  private chunkRetryCount = 0;
  private onStateChange: StateChangeCallback;

  /** Exposed read-only so the service worker can check which tab is active. */
  get activeTabId(): number | null {
    return this.session?.tabId ?? null;
  }

  constructor(onStateChange: StateChangeCallback) {
    this.onStateChange = onStateChange;
    this.chromeTtsEngine.onWordBoundary = (charIndex, charLength) => {
      this.onWordBoundary(charIndex, charLength, 'chrome-tts');
    };
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  getState(): PlayerStatePayload {
    return {
      status:      this.status,
      chunkIndex:  this.session?.chunkIndex  ?? 0,
      totalChunks: this.session?.totalChunks ?? 0,
      errorMessage: this.errorMessage,
      voices: this.cachedVoices.map(v => ({
        id:    v.id,
        name:  v.name,
        lang:  v.lang,
        local: v.local,
      })),
    };
  }

  /**
   * Start playing from the active tab.
   * `tabId` is always needed even for 'paste' so we can target the right tab
   * for highlight / scroll messages.
   */
  async play(tabId: number, trigger: PlayTrigger, pasteText = ''): Promise<void> {
    // Stop any in-progress session first
    await this.stop(true);
    this.setStatus('loading');

    try {
      // 1. Ensure voices are loaded (non-fatal — TTS can still auto-select)
      if (this.cachedVoices.length === 0) {
        await this.loadVoices();
      }
      // If still empty after loading, we continue without a specific voice Id;
      // the engine will use its default selection.
      // 2. Resolve text + chunks
      let chunks: Chunk[];
      let startIndex = 0;

      if (trigger === 'paste') {
        const { createChunks } = await import('../lib/text/chunker');
        chunks = createChunks(pasteText);
      } else {
        const extracted = await this.extractFromTab(tabId, trigger);
        chunks     = extracted.chunks;
        startIndex = extracted.startIndex;
      }

      if (chunks.length === 0) {
        throw new Error('I couldn’t find any readable text on this page.');
      }

      // 3. Initialise session
      this.session = {
        tabId,
        chunks,
        chunkIndex:  startIndex,
        totalChunks: chunks.length,
        pasteText,
        trigger,
      };

      // 4. Persist session in storage.session so a SW restart can recover
      await this.saveSession();

      // 5. Kick off playback
      this.setStatus('playing');
      await this.playCurrentChunk();

    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
    }
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.setStatus('paused');
    if (this.activeEngine === 'chrome-tts') {
      this.chromeTtsEngine.pause();
    } else {
      this.sendToOffscreen({ type: 'PAUSE' }).catch(() => undefined);
    }
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.setStatus('playing');
    if (this.restartOnResume) {
      this.restartOnResume = false;
      this.playCurrentChunk().catch(err => {
        this.setError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (this.activeEngine === 'chrome-tts') {
      this.chromeTtsEngine.resume();
    } else {
      this.sendToOffscreen({ type: 'RESUME' }).catch(() => undefined);
    }
  }

  /**
   * Apply a new rate immediately — even mid-playback.
   * Persists to storage so the next chunk also uses the new rate.
   */
  applyRate(rate: number): void {
    // Persist so playCurrentChunk picks it up for subsequent chunks.
    loadSettings().then(s => saveSettings({ ...s, rate })).catch(() => undefined);
    if (this.status === 'playing' && this.session) {
      if (this.activeEngine === 'chrome-tts') {
        const generation = ++this.playbackGeneration;
        this.chromeTtsEngine.setRate(rate)
          .then(() => {
            if (generation === this.playbackGeneration) {
              void this.onChunkDone(true, undefined, 'chrome-tts');
            }
          })
          .catch((err: unknown) => {
            if (generation === this.playbackGeneration) {
              void this.onChunkDone(
                false,
                err instanceof Error ? err.message : String(err),
                'chrome-tts',
              );
            }
          });
      } else {
        this.sendToOffscreen({ type: 'SET_RATE', rate }).catch(() => undefined);
      }
    }
  }

  /** Persist a voice choice and restart the current part with that voice. */
  async applyVoice(voiceId: string): Promise<void> {
    await saveSettings({ voiceId });
    if (!this.session) {
      if (voiceId.startsWith('kokoro:')) {
        this.activeEngine = 'kokoro';
        await this.preloadVoice(voiceId).catch(() => undefined);
      } else if (this.activeEngine === 'kokoro') {
        this.activeEngine = 'speech-synthesis';
        await this.closeOffscreen();
      }
      return;
    }

    ++this.playbackGeneration;
    this.chromeTtsEngine.stop();
    if (this.offscreenReady) {
      await this.sendToOffscreen({ type: 'STOP' }).catch(() => undefined);
    }

    if (this.status === 'paused') {
      this.restartOnResume = true;
      return;
    }
    if (this.status !== 'playing') return;

    await this.playCurrentChunk();
  }

  async stop(keepOffscreenOpen = false): Promise<void> {
    if (this.status === 'idle') return;

    // Clear page highlight before stopping
    if (this.session) {
      this.clearHighlight(this.session.tabId).catch(() => undefined);
    }

    this.chunkRetryCount = 0;
    this.restartOnResume = false;
    ++this.playbackGeneration;
    this.chromeTtsEngine.stop();
    if (this.offscreenReady) {
      await this.sendToOffscreen({ type: 'STOP' });
    }
    if (!keepOffscreenOpen && this.activeEngine !== 'kokoro') {
      await this.closeOffscreen();
    }

    this.session = null;
    await this.clearSession();
    this.setStatus('idle');
  }

  /** Called by the service worker when the offscreen document sends CHUNK_DONE. */
  async onChunkDone(
    ok: boolean,
    error?: string,
    engine: EngineId = 'speech-synthesis',
  ): Promise<void> {
    if (!this.session) return;
    if (engine !== this.activeEngine) return;

    if (!ok) {
      if (isTransientTtsError(error) && this.chunkRetryCount < 2) {
        this.chunkRetryCount++;
        if (this.status === 'loading') this.setStatus('playing');
        await delay(250);
        await this.playCurrentChunk();
        return;
      }
      this.setError(error ?? 'Something went wrong while reading this text.');
      return;
    }

    if (this.status !== 'playing') return;

    this.session.chunkIndex++;
    this.chunkRetryCount = 0;
    await this.saveSession();

    if (this.session.chunkIndex >= this.session.totalChunks) {
      // Playback complete
      this.clearHighlight(this.session.tabId).catch(() => undefined);
      this.session = null;
      await this.clearSession();
      this.setStatus('idle');
      return;
    }

    this.emitState();
    await this.playCurrentChunk();
  }

  /** Attempt to resume an interrupted session after a service-worker restart. */
  async tryRestoreSession(): Promise<void> {
    // Guard: if play() was already called (e.g. from a context-menu event that
    // fired concurrently with this IIFE), do nothing — we don't want to
    // overwrite the new session or start a second playback loop.
    if (this.status !== 'idle') return;

    const raw = await this.loadPersistedSession();
    if (!raw) return;

    // Re-verify the tab still exists
    const tab = await chrome.tabs.get(raw.tabId).catch(() => null);
    if (!tab?.id) {
      await this.clearSession();
      return;
    }

    // Resume from where we left off
    this.session       = raw;
    this.status        = 'playing';
    this.errorMessage  = null;

    if (this.cachedVoices.length === 0) {
      await this.loadVoices();
    }
    this.emitState();
    await this.playCurrentChunk();
  }

  /** Forward a spoken-word boundary from the active engine to the page. */
  onWordBoundary(
    charIndex: number,
    charLength: number,
    engine: EngineId,
  ): void {
    if (!this.session || this.status !== 'playing') return;
    if (engine !== this.activeEngine) return;
    this.sendHighlightWord(this.session.tabId, charIndex, charLength).catch(() => undefined);
  }

  onEngineStatus(engine: EngineId, status: 'loading' | 'ready'): void {
    if (!this.session || engine !== this.activeEngine) return;
    if (status === 'loading' && this.status === 'playing') {
      this.setStatus('loading');
    } else if (status === 'ready' && this.status === 'loading') {
      this.setStatus('playing');
    }
  }

  /** Refresh voice cache from the browser TTS service used for playback. */
  async loadVoices(): Promise<void> {
    const [speechSynthesisVoices, chromeTtsVoices] = await Promise.all([
      (async () => {
        try {
          await this.ensureOffscreen();
          return await withTimeout(
            this.requestVoicesFromOffscreen(),
            VOICE_TIMEOUT_MS,
            [],
          );
        } catch {
          return [];
        }
      })(),
      this.chromeTtsEngine.getVoices().catch(() => []),
    ]);

    const byId = new Map<string, Voice>();
    for (const voice of [...speechSynthesisVoices, ...chromeTtsVoices]) {
      byId.set(voice.id, voice);
    }

    const preferredLanguage = chrome.i18n.getUILanguage();
    this.cachedVoices = rankVoices(
      Array.from(byId.values()).map(({ score: _score, ...voice }) => voice),
      preferredLanguage,
    );
    this.emitState();

    // A previously selected Kokoro voice is an explicit opt-in. Warm it in
    // the background so pressing Play does not also begin the model download.
    const settings = await loadSettings();
    if (settings.voiceId.startsWith('kokoro:')) {
      this.activeEngine = 'kokoro';
      void this.preloadVoice(settings.voiceId).catch(() => undefined);
    }
  }

  private async preloadVoice(voiceId: string): Promise<void> {
    await this.sendToOffscreen({ type: 'PRELOAD_VOICE', voiceId });
  }

  /** Request voices directly from the offscreen SpeechSynthesis instance. */
  private requestVoicesFromOffscreen(): Promise<Voice[]> {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'GET_VOICES_REQUEST' },
        (response: unknown) => {
          if (chrome.runtime.lastError || !response) {
            resolve([]);
            return;
          }
          const r = response as { ok: true; voices: Voice[] } | { ok: false };
          resolve(r.ok ? r.voices : []);
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Private — chunk playback
  // -------------------------------------------------------------------------

  private async playCurrentChunk(): Promise<void> {
    if (!this.session || this.status !== 'playing') return;
    this.restartOnResume = false;

    const { tabId, chunks, chunkIndex } = this.session;
    const chunk = chunks[chunkIndex];
    if (!chunk) return;

    // Send highlight + scroll to content script
    this.sendHighlight(tabId, chunkIndex).catch(() => undefined);

    // Resolve voice
    const settings = await loadSettings();
    if (
      this.cachedVoices.length === 0 ||
      (settings.voiceId && !this.cachedVoices.some(v => v.id === settings.voiceId))
    ) {
      await this.loadVoices();
    }
    const voiceId = resolveVoiceId(
      settings.voiceId,
      this.cachedVoices,
      chrome.i18n.getUILanguage(),
    );

    const generation = ++this.playbackGeneration;
    if (voiceId?.startsWith('chrome-tts:')) {
      this.activeEngine = 'chrome-tts';
      if (this.offscreenReady) {
        await this.sendToOffscreen({ type: 'STOP' }).catch(() => undefined);
      }

      void this.chromeTtsEngine.speak(chunk.text, {
        voiceId,
        rate:   settings.rate,
        pitch:  settings.pitch,
        volume: settings.volume,
      }).then(() => {
        if (generation === this.playbackGeneration) {
          void this.onChunkDone(true, undefined, 'chrome-tts');
        }
      }).catch((err: unknown) => {
        if (generation === this.playbackGeneration) {
          void this.onChunkDone(
            false,
            err instanceof Error ? err.message : String(err),
            'chrome-tts',
          );
        }
      });
      return;
    }

    this.activeEngine = voiceId?.startsWith('kokoro:')
      ? 'kokoro'
      : 'speech-synthesis';
    this.chromeTtsEngine.stop();

    const msg: OffscreenMessage = {
      type:    'SPEAK_CHUNK',
      text:    chunk.text,
      prefetchText: voiceId?.startsWith('kokoro:')
        ? chunks[chunkIndex + 1]?.text
        : undefined,
      voiceId: voiceId ?? undefined,
      rate:    settings.rate,
      pitch:   settings.pitch,
      volume:  settings.volume,
    };

    await this.sendToOffscreen(msg);
  }

  // -------------------------------------------------------------------------
  // Private — content script communication
  // -------------------------------------------------------------------------

  private async extractFromTab(
    tabId: number,
    trigger: PlayTrigger,
  ): Promise<{ chunks: Chunk[]; startIndex: number }> {
    // Inject the content script if it hasn't loaded yet (e.g. right after install)
    await chrome.scripting
      .executeScript({ target: { tabId }, files: ['dist/content/content.js'] })
      .catch(() => undefined); // already injected — ignore error

    const fromSelectionStart = trigger === 'from-here';
    const extractMsg: ContentScriptMessage = { type: 'EXTRACT_TEXT', fromSelectionStart };
    const response = await chrome.tabs
      .sendMessage<ContentScriptMessage, ContentScriptResponse>(tabId, extractMsg)
      .catch((err: unknown) => ({
        ok:    false as const,
        error: err instanceof Error ? err.message : 'Could not reach content script',
      }));

    if (!response.ok) {
      throw new Error(response.error);
    }

    // For 'selection' trigger, filter to only populated selection text
    if (trigger === 'selection' && response.source !== 'selection') {
      throw new Error('Select some text on the page, then try again.');
    }

    return {
      chunks:     response.chunks,
      startIndex: response.startChunkIndex ?? 0,
    };
  }

  private async sendHighlight(tabId: number, chunkIndex: number): Promise<void> {
    const settings = await loadSettings();
    const msg: ContentScriptMessage = {
      type:       'HIGHLIGHT_CHUNK',
      chunkIndex,
      scroll:     settings.autoScroll,
    };
    await chrome.tabs
      .sendMessage(tabId, msg)
      .catch(() => undefined);
  }

  private async clearHighlight(tabId: number): Promise<void> {
    const msg: ContentScriptMessage = { type: 'CLEAR_HIGHLIGHT' };
    await chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Private — offscreen document lifecycle
  // -------------------------------------------------------------------------

  /**
   * Check whether the offscreen document is already open.
   *
   * Primary path  — chrome.runtime.getContexts (Chrome 116+, MV3 stable):
   *   Filters by both context type and the exact document URL so this
   *   method is safe even if another part of the extension ever creates
   *   a second offscreen document for a different purpose.
   *
   * Fallback path — clients.matchAll (Service Worker Clients API):
   *   Available in every MV3 service worker regardless of Chrome version.
   *   Matches the offscreen document URL among all controlled clients.
   */
  // -------------------------------------------------------------------------
  // Private — session persistence (chrome.storage.session)
  // -------------------------------------------------------------------------
  //
  // chrome.storage.session persists across service-worker idle restarts within
  // the same browser session.  It is cleared when the browser itself shuts
  // down, so it must NOT be treated as durable long-term storage.  Its sole
  // purpose here is to survive the brief window where Chrome kills and revives
  // the service worker mid-playback (e.g. after ~30 s of inactivity).
  // -------------------------------------------------------------------------

  private async ensureOffscreen(): Promise<void> {
    if (this.offscreenReady) return;

    const hasDoc = await this.hasOffscreenDocument();
    if (!hasDoc) {
      try {
        await chrome.offscreen.createDocument({
          url:           OFFSCREEN_URL,
          reasons: [
            chrome.offscreen.Reason.AUDIO_PLAYBACK,
            chrome.offscreen.Reason.WORKERS,
          ],
          justification: 'Local text-to-speech inference and audio playback',
        });
      } catch (err) {
        if (!String(err).includes('Only a single offscreen document')) {
          throw err;
        }
      }
    }

    this.offscreenReady = true;
  }

  private async sendHighlightWord(
    tabId: number,
    charIndex: number,
    charLength: number,
  ): Promise<void> {
    const msg: ContentScriptMessage = {
      type: 'HIGHLIGHT_WORD',
      charIndex,
      charLength,
    };
    await chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
  }

  private async hasOffscreenDocument(): Promise<boolean> {
    if (typeof chrome.runtime.getContexts === 'function') {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [OFFSCREEN_URL],
      });
      return contexts.length > 0;
    }

    const swSelf = self as unknown as ServiceWorkerGlobalScope;
    const allClients = await swSelf.clients.matchAll();
    return allClients.some((client: Client) => client.url === OFFSCREEN_URL);
  }

  private async closeOffscreen(): Promise<void> {
    if (!this.offscreenReady) return;
    await chrome.offscreen.closeDocument().catch(() => undefined);
    this.offscreenReady = false;
  }

  private async sendToOffscreen(msg: OffscreenMessage): Promise<void> {
    await this.ensureOffscreen();
    await chrome.runtime.sendMessage(msg).catch(() => undefined);
  }

  private async saveSession(): Promise<void> {
    if (!this.session) return;
    // Only serialisable fields — Chunk has no DOM refs
    await chrome.storage.session
      .set({ [SESSION_KEY]: this.session })
      .catch(() => undefined);
  }

  private async loadPersistedSession(): Promise<PlayerSession | null> {
    return new Promise(resolve => {
      chrome.storage.session.get(SESSION_KEY, res => {
        resolve((res[SESSION_KEY] as PlayerSession | undefined) ?? null);
      });
    });
  }

  private async clearSession(): Promise<void> {
    await chrome.storage.session.remove(SESSION_KEY).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Private — state helpers
  // -------------------------------------------------------------------------

  private setStatus(status: PlayerStatus): void {
    this.status       = status;
    this.errorMessage = null;
    this.emitState();
  }

  private setError(message: string): void {
    this.chunkRetryCount = 0;
    ++this.playbackGeneration;
    this.chromeTtsEngine.stop();
    this.sendToOffscreen({ type: 'STOP' }).catch(() => undefined);
    this.closeOffscreen().catch(() => undefined);
    this.status       = 'error';
    this.errorMessage = message;
    this.session      = null;
    this.clearSession().catch(() => undefined);
    this.emitState();
  }

  private emitState(): void {
    this.onStateChange(this.getState());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the best voice ID to use for the current utterance.
 * Falls back to '' (let the engine choose) when no match is found.
 */
function resolveVoiceId(
  savedVoiceId: string,
  voices: Voice[],
  preferredLanguage?: string,
): string | null {
  if (savedVoiceId) {
    if (voices.length === 0 || voices.some(v => v.id === savedVoiceId)) {
      return savedVoiceId;
    }
  }
  // Kokoro is an explicit opt-in because selecting it may trigger the first
  // model download. Automatic mode must remain instant and lightweight.
  const automaticVoices = voices.filter(voice => voice.engine !== 'kokoro');
  const best = pickBestVoice(automaticVoices, preferredLanguage);
  return best?.id ?? null;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function isTransientTtsError(error?: string): boolean {
  return /interrupted|cancelled/i.test(error ?? '');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
