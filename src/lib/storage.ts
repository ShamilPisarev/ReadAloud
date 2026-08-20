import type { ExtractionSource } from './text/types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ReadAloudSettings {
  /** Selected voice ID (`"<engineId>:<voiceName>"`). Empty string = auto. */
  voiceId:  string;
  /** Speaking rate. 0.5 – 2.0, default 1. */
  rate:     number;
  /** Pitch. 0.5 – 2.0, default 1. */
  pitch:    number;
  /** Volume. 0 – 1, default 1. */
  volume:   number;
  /** Preferred text source for page reads. */
  source:   ExtractionSource;
  /** Auto-scroll page to highlighted chunk. */
  autoScroll: boolean;
  /** Whether the extension is enabled (double-click, toolbar, etc.). */
  enabled: boolean;
}

const DEFAULTS: ReadAloudSettings = {
  voiceId:    '',
  rate:       1,
  pitch:      1,
  volume:     1,
  source:     'article',
  autoScroll: true,
  enabled:    true,
};

const STORAGE_KEY = 'readAloudSettings';
const API_KEY_STORAGE_KEY = 'openRouterApiKey';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load settings from `chrome.storage.sync`, filling in defaults for any missing keys. */
export async function loadSettings(): Promise<ReadAloudSettings> {
  return new Promise(resolve => {
    chrome.storage.sync.get(STORAGE_KEY, result => {
      const stored = (result[STORAGE_KEY] ?? {}) as Partial<ReadAloudSettings>;
      resolve({ ...DEFAULTS, ...stored });
    });
  });
}

/**
 * OpenRouter API key — kept in `chrome.storage.local` (NOT sync) so the
 * secret never leaves this machine via profile sync.
 */
export async function loadApiKey(): Promise<string> {
  return new Promise(resolve => {
    chrome.storage.local.get(API_KEY_STORAGE_KEY, result => {
      resolve((result[API_KEY_STORAGE_KEY] as string | undefined) ?? '');
    });
  });
}

export async function saveApiKey(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey.trim() }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/** Persist a full or partial settings update. */
export async function saveSettings(
  patch: Partial<ReadAloudSettings>,
): Promise<void> {
  const current = await loadSettings();
  const merged  = { ...current, ...patch };
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: merged }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}
