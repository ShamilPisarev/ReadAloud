import type { SpeakOptions, SpeechEngine, Voice } from './types';
import { rankVoices, type UnscoredVoice } from './voice-ranking';

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const MODEL_ID = 'deepgram/flux-tts:free';

/**
 * Preferred chunk size for this engine. Every chunk is one API request, and
 * OpenRouter's free tier caps requests per day — so batch far more text per
 * request than the 280-char default used for local engines, while staying
 * safely under typical TTS input limits (~2 000 chars).
 */
export const OPENROUTER_CHUNK_CHARS = 1_800;

/** 429 handling: how many times to retry one request, and the base delay. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DELAY_MS = 2_500;

/**
 * Voice IDs published by OpenRouter for deepgram/flux-tts
 * (`GET /api/v1/models?output_modalities=speech` → `supported_voices`).
 * All Flux voices are English-only.
 */
const FLUX_VOICES = [
  'flux-alexis-en', 'flux-bree-en', 'flux-brittany-en', 'flux-brooke-en',
  'flux-bruce-en', 'flux-cliff-en', 'flux-cole-en', 'flux-colin-en',
  'flux-conor-en', 'flux-donovan-en', 'flux-drew-en', 'flux-elise-en',
  'flux-gemma-en', 'flux-haley-en', 'flux-hannah-en', 'flux-heather-en',
  'flux-jack-en', 'flux-kai-en', 'flux-kelsey-en', 'flux-kit-en',
  'flux-maeve-en', 'flux-marcelo-en', 'flux-marcus-en', 'flux-meena-en',
  'flux-meghan-en', 'flux-miles-en', 'flux-naveen-en', 'flux-paige-en',
  'flux-priya-en', 'flux-rufus-en', 'flux-sean-en', 'flux-sharon-en',
  'flux-sienna-en', 'flux-tanner-en', 'flux-wade-en', 'flux-wes-en',
] as const;

type FluxVoiceId = (typeof FLUX_VOICES)[number];

const DEFAULT_VOICE: FluxVoiceId = 'flux-hannah-en';

type PreparedAudio = {
  key: string;
  promise: Promise<Blob>;
};

/**
 * Cloud TTS via OpenRouter's OpenAI-compatible audio endpoint, currently
 * pinned to Deepgram Flux (`deepgram/flux-tts:free`).
 *
 * Requires an OpenRouter API key set on `apiKey` before `speak()` is called.
 * Playback uses an HTMLAudioElement so rate changes apply instantly through
 * `playbackRate` (pitch-preserving) without re-synthesising, and word
 * highlighting is driven off `currentTime` so it stays aligned across rate
 * changes and pauses.
 *
 * No chrome.* APIs — this file is shared with the desktop app.
 */
export class OpenRouterEngine implements SpeechEngine {
  readonly engineId = 'openrouter' as const;

  /** OpenRouter API key. Injected by the host (offscreen message / settings). */
  apiKey = '';

  onWordBoundary?: (charIndex: number, charLength: number) => void;

  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private boundaryTimer: ReturnType<typeof setInterval> | null = null;
  private settlePlayback: (() => void) | null = null;
  private generation = 0;
  private currentRate = 1;
  private preparedAudio: PreparedAudio | null = null;

  getVoices(): Promise<Voice[]> {
    const voices: UnscoredVoice[] = FLUX_VOICES.map(id => ({
      id: `openrouter:${id}`,
      name: `${displayName(id)} — Flux TTS`,
      lang: 'en-US',
      local: false,
      engine: 'openrouter',
    }));
    return Promise.resolve(rankVoices(voices));
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    const generation = ++this.generation;
    this.stopAudioOnly();

    const voice = this.resolveVoice(options.voiceId);
    this.currentRate = clamp(options.rate ?? 1, 0.25, 4);
    const volume = clamp(options.volume ?? 1, 0, 1);

    const blob = await this.getAudio(text, voice);
    if (generation !== this.generation) return;

    await this.playBlob(blob, text, volume, generation, () => {
      if (generation !== this.generation) return;
      if (options.prefetchText) this.prepareAudio(options.prefetchText, voice);
    });
  }

  /**
   * Apply a new rate to the in-flight utterance via `playbackRate`.
   * Resolves when the current utterance finishes (the offscreen host treats
   * that as the chunk completing), or immediately when nothing is playing.
   */
  setRate(rate: number): Promise<void> {
    this.currentRate = clamp(rate, 0.25, 4);
    const audio = this.audio;
    if (!audio) return Promise.resolve();

    audio.playbackRate = this.currentRate;
    // Hand the completion promise over to this call: speak()'s own promise
    // was invalidated by the host bumping its generation counter.
    return new Promise(resolve => {
      const previousSettle = this.settlePlayback;
      this.settlePlayback = () => {
        previousSettle?.();
        resolve();
      };
    });
  }

  pause(): void {
    this.audio?.pause();
  }

  resume(): void {
    this.audio?.play().catch(() => undefined);
  }

  stop(): void {
    ++this.generation;
    this.stopAudioOnly();
    this.preparedAudio = null;
  }

  // -------------------------------------------------------------------------
  // Private — synthesis
  // -------------------------------------------------------------------------

  private async getAudio(text: string, voice: FluxVoiceId): Promise<Blob> {
    const key = audioKey(text, voice);
    if (this.preparedAudio?.key === key) {
      const prepared = this.preparedAudio;
      this.preparedAudio = null;
      return prepared.promise;
    }
    this.preparedAudio = null;
    return this.fetchAudio(text, voice);
  }

  private prepareAudio(text: string, voice: FluxVoiceId): void {
    if (!text) return;
    const key = audioKey(text, voice);
    if (this.preparedAudio?.key === key) return;

    const prepared: PreparedAudio = {
      key,
      promise: this.fetchAudio(text, voice),
    };
    this.preparedAudio = prepared;
    prepared.promise.catch(() => {
      if (this.preparedAudio === prepared) this.preparedAudio = null;
    });
  }

  private async fetchAudio(text: string, voice: FluxVoiceId): Promise<Blob> {
    if (!this.apiKey) {
      throw new Error(
        'Flux voices need an OpenRouter API key. Add one in the Read Aloud settings (openrouter.ai/keys).',
      );
    }

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_ID,
          input: text,
          voice,
          response_format: 'mp3',
        }),
      });

      if (response.ok) return response.blob();

      // Free-tier rate limits are transient — wait and retry instead of
      // aborting playback mid-article.
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await new Promise(resolve =>
          setTimeout(resolve, RATE_LIMIT_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw new Error(await describeApiError(response));
    }
  }

  // -------------------------------------------------------------------------
  // Private — playback
  // -------------------------------------------------------------------------

  private playBlob(
    blob: Blob,
    text: string,
    volume: number,
    generation: number,
    onStarted?: () => void,
  ): Promise<void> {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preservesPitch = true;
    audio.playbackRate = this.currentRate;
    audio.volume = volume;
    this.audio = audio;
    this.audioUrl = url;

    return new Promise((resolve, reject) => {
      this.settlePlayback = resolve;

      audio.onended = () => {
        if (generation !== this.generation) return;
        this.stopAudioOnly();
      };
      audio.onerror = () => {
        if (generation !== this.generation) return;
        // Detach the settle callback first so stopAudioOnly() cannot resolve
        // this promise before the rejection below reaches the caller.
        this.settlePlayback = null;
        this.stopAudioOnly();
        reject(new Error('Could not play the synthesized audio.'));
      };
      audio.onloadedmetadata = () => {
        if (generation !== this.generation) return;
        this.startBoundaryTimer(audio, text);
      };

      audio.play()
        .then(() => onStarted?.())
        .catch((err: unknown) => {
          if (generation !== this.generation) return;
          this.settlePlayback = null;
          this.stopAudioOnly();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /**
   * Estimate the currently spoken word from `currentTime`, weighting words by
   * length (same heuristic as the Kokoro engine). Media time is unaffected by
   * `playbackRate`, so highlighting survives live rate changes.
   */
  private startBoundaryTimer(audio: HTMLAudioElement, text: string): void {
    this.clearBoundaryTimer();
    const durationSec = audio.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) return;

    const words: Array<{ charIndex: number; charLength: number }> = [];
    const regex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      words.push({ charIndex: match.index, charLength: match[0].length });
    }
    if (words.length === 0) return;

    const totalWeight = words.reduce((sum, w) => sum + w.charLength + 1, 0);
    const startTimes: number[] = [];
    let consumed = 0;
    for (const word of words) {
      startTimes.push((consumed / totalWeight) * durationSec);
      consumed += word.charLength + 1;
    }

    let lastIndex = -1;
    const update = (): void => {
      if (audio.paused) return;
      const elapsed = audio.currentTime;
      let index = Math.max(0, lastIndex);
      while (index + 1 < words.length && (startTimes[index + 1] ?? 0) <= elapsed) {
        index++;
      }
      if (index === lastIndex) return;
      lastIndex = index;
      const word = words[index];
      if (word) this.onWordBoundary?.(word.charIndex, word.charLength);
    };
    update();
    this.boundaryTimer = setInterval(update, 75);
  }

  private clearBoundaryTimer(): void {
    if (this.boundaryTimer !== null) {
      clearInterval(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  private stopAudioOnly(): void {
    this.clearBoundaryTimer();
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      audio.pause();
      audio.removeAttribute('src');
    }
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    const settle = this.settlePlayback;
    this.settlePlayback = null;
    settle?.();
  }

  private resolveVoice(voiceId?: string): FluxVoiceId {
    const requested = voiceId?.startsWith('openrouter:')
      ? voiceId.slice('openrouter:'.length)
      : DEFAULT_VOICE;
    const voice = FLUX_VOICES.find(candidate => candidate === requested);
    return voice ?? DEFAULT_VOICE;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function audioKey(text: string, voice: FluxVoiceId): string {
  return `${voice} ${text}`;
}

/** `flux-alexis-en` → `Alexis` */
function displayName(id: FluxVoiceId): string {
  const raw = id.replace(/^flux-/, '').replace(/-en$/, '');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Non-200 responses carry a JSON error body; map the common cases to advice. */
async function describeApiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // Body was not JSON — fall through to the status-based message.
  }

  switch (response.status) {
    case 401:
      return 'OpenRouter rejected the API key. Check the key in the Read Aloud settings.';
    case 402:
      return 'The OpenRouter account has no credits left for this request.';
    case 429:
      return 'OpenRouter free-tier rate limit reached — wait a moment and press Play again.';
    default:
      return detail
        ? `OpenRouter error ${response.status}: ${detail}`
        : `OpenRouter error ${response.status}.`;
  }
}
