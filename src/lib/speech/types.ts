/** Which underlying platform provides the voice. */
export type EngineId = 'chrome-tts' | 'speech-synthesis' | 'kokoro';

/**
 * Normalized voice entry shared across both engines.
 * `id` is stable across calls: `"<engineId>:<voiceName>"`.
 */
export interface Voice {
  /** Stable unique ID: `"chrome-tts:Google US English"` */
  id: string;
  /** Human-readable display name */
  name: string;
  /** BCP-47 language tag, e.g. `"en-US"` */
  lang: string;
  /** True when the voice renders locally (no network call). */
  local: boolean;
  /** Which engine owns this voice */
  engine: EngineId;
  /**
   * Computed quality/preference score (higher = more preferred).
   * Factors: local, language match, quality keywords in name.
   */
  score: number;
}

/** Options forwarded to the underlying TTS call. */
export interface SpeakOptions {
  /**
   * Voice to use. Pass the `Voice.id` string.
   * If omitted the engine picks the best available voice.
   */
  voiceId?: string;
  /** Speaking rate. 1 = normal speed. Range: 0.1 – 10 (chrome.tts scale). */
  rate?: number;
  /** Pitch multiplier. 1 = normal. Range: 0 – 2. */
  pitch?: number;
  /** Volume. Range: 0 – 1. Default 1. */
  volume?: number;
  /** BCP-47 language hint used for automatic voice selection. */
  lang?: string;
  /** Optional look-ahead text that a local engine may synthesize in advance. */
  prefetchText?: string;
}

/** Common contract implemented by every speech engine. */
export interface SpeechEngine {
  readonly engineId: EngineId;

  /** Discover all available voices, returned ranked best-first. */
  getVoices(): Promise<Voice[]>;

  /**
   * Speak `text`. Resolves when the utterance finishes (or is interrupted).
   * Rejects on TTS error.
   */
  speak(text: string, options?: SpeakOptions): Promise<void>;

  /** Pause the current utterance (no-op when nothing is playing). */
  pause(): void;

  /** Resume a paused utterance. */
  resume(): void;

  /** Stop and discard the current utterance. */
  stop(): void;
}
