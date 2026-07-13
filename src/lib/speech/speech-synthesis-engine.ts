import type { Voice, SpeakOptions, SpeechEngine } from './types';
import { rankVoices, type UnscoredVoice } from './voice-ranking';

/**
 * SpeechEngine backed by the Web `SpeechSynthesis` API.
 *
 * Available in: offscreen documents, normal web pages.
 * NOT available in: background service workers (no `window`).
 *
 * The offscreen document must be created with reason `"AUDIO_PLAYBACK"` and
 * justification that includes text-to-speech. Chrome requires this context
 * for `speechSynthesis` to produce audible output.
 *
 * Rate/pitch use the SpeechSynthesisUtterance scale:
 *   rate  → 0.1 – 10  (1 = normal)
 *   pitch → 0 – 2     (1 = normal)
 *   volume → 0 – 1    (1 = full)
 */
export class SpeechSynthesisEngine implements SpeechEngine {
  readonly engineId = 'speech-synthesis' as const;

  private readonly synth: SpeechSynthesis;

  /** Callback fired for each spoken word boundary. */
  onWordBoundary?: (charIndex: number, charLength: number) => void;

  /** Current pending speak options, kept so setRate() can restart the utterance. */
  private currentText:    string    = '';
  private currentOptions: SpeakOptions = {};
  private currentCharIndex = 0;   // position in currentText when interrupted

  /** Timer-based word tracking (fallback when onboundary doesn't fire). */
  private fallbackTimer:       ReturnType<typeof setInterval> | null = null;
  private boundaryCheckTimer:  ReturnType<typeof setTimeout>  | null = null;
  private hasBoundaryEvent = false;

  /** Pass a custom `SpeechSynthesis` instance for testing; defaults to `window.speechSynthesis`. */
  constructor(synth: SpeechSynthesis = window.speechSynthesis) {
    this.synth = synth;
  }

  // -------------------------------------------------------------------------
  // Voice discovery
  // -------------------------------------------------------------------------

  getVoices(): Promise<Voice[]> {
    return new Promise<Voice[]>(resolve => {
      const convert = (raw: SpeechSynthesisVoice[]): Voice[] => {
        const unscored: UnscoredVoice[] = raw.map(v => ({
          id:     `speech-synthesis:${v.name}`,
          name:   v.name,
          lang:   v.lang,
          local:  v.localService,
          engine: 'speech-synthesis' as const,
        }));
        return rankVoices(unscored);
      };

      // Chromium populates the list synchronously after the first call on
      // most platforms, but fires `voiceschanged` asynchronously on others.
      const immediate = this.synth.getVoices();
      if (immediate.length > 0) {
        resolve(convert(immediate));
        return;
      }

      // Wait for the async event; guard against never firing with a short timeout.
      let settled = false;

      const onChanged = () => {
        if (settled) return;
        settled = true;
        resolve(convert(this.synth.getVoices()));
      };

      this.synth.addEventListener('voiceschanged', onChanged, { once: true });

      // Fallback: resolve with empty list after 3 s so callers never hang.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        this.synth.removeEventListener('voiceschanged', onChanged);
        resolve(convert(this.synth.getVoices()));
      }, 3_000);
    });
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    // Some Chromium builds populate voices lazily; wait once here so an
    // explicitly selected voice can actually be resolved on the first chunk.
    if (this.synth.getVoices().length === 0) {
      await this.getVoices().catch(() => []);
    }

    // Cancel any in-flight utterance before starting a new one.
    this.synth.cancel();
    this.clearTimers();
    this.currentText    = text;
    this.currentOptions = options;
    this.currentCharIndex = 0;

    return this._speakFrom(text, options);
  }

  /**
   * Change the playback rate while speaking.  Cancels the current utterance
   * and restarts it from approximately the last word boundary position.
   *
   * Returns a promise that resolves when the restarted utterance finishes.
   * The caller must wire this promise to the chunk-done notification so the
   * player advances only after the restarted speech completes.
   */
  async setRate(rate: number): Promise<void> {
    if (!this.currentText) return Promise.resolve();
    this.currentOptions = { ...this.currentOptions, rate };
    const remaining = this.currentText.slice(this.currentCharIndex);
    if (!remaining.trim()) return Promise.resolve();
    if (this.synth.getVoices().length === 0) {
      await this.getVoices().catch(() => []);
    }
    this.synth.cancel();
    this.clearTimers();
    return this._speakFrom(remaining, this.currentOptions);
  }

  private _speakFrom(text: string, options: SpeakOptions): Promise<void> {
    // Pre-parse word positions for the fallback timer.
    const words: Array<{ start: number; length: number }> = [];
    const wordRegex = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text)) !== null) {
      words.push({ start: m.index, length: m[0].length });
    }

    const baseOffset = this.currentText.length - text.length;
    this.hasBoundaryEvent = false;

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);

      utterance.rate   = clamp(options.rate   ?? 1, 0.1, 10);
      utterance.pitch  = clamp(options.pitch  ?? 1, 0,   2);
      utterance.volume = clamp(options.volume ?? 1, 0,   1);

      if (options.lang) {
        utterance.lang = options.lang;
      }

      if (options.voiceId) {
        const colonIdx  = options.voiceId.indexOf(':');
        const voiceName = colonIdx !== -1
          ? options.voiceId.slice(colonIdx + 1)
          : options.voiceId;
        const match = this.synth.getVoices().find(v => v.name === voiceName);
        if (match) utterance.voice = match;
      }

      // --- Native word boundary handler ---
      utterance.onboundary = (event: SpeechSynthesisEvent) => {
        if (event.name !== 'word') return;

        // Native events work — cancel any pending fallback timer.
        if (!this.hasBoundaryEvent) {
          this.hasBoundaryEvent = true;
          if (this.boundaryCheckTimer !== null) {
            clearTimeout(this.boundaryCheckTimer);
            this.boundaryCheckTimer = null;
          }
          if (this.fallbackTimer !== null) {
            clearInterval(this.fallbackTimer);
            this.fallbackTimer = null;
          }
        }

        const fullOffset = baseOffset + event.charIndex;
        this.currentCharIndex = fullOffset;
        const wordSlice = text.slice(event.charIndex);
        const wordMatch = wordSlice.match(/^\S+/);
        const len = wordMatch ? wordMatch[0].length : 1;
        this.onWordBoundary?.(fullOffset, len);
      };

      // --- Fallback: timer-based word estimation ---
      // Wait 400 ms for a native boundary event; if none arrives, start a
      // timer that walks through words at the approximate speech rate.
      this.boundaryCheckTimer = setTimeout(() => {
        this.boundaryCheckTimer = null;
        if (this.hasBoundaryEvent || words.length === 0) return;

        let idx = 0;
        const wordsPerSec = Math.max(1, 2.5 * (options.rate ?? 1));
        const intervalMs  = Math.max(50, Math.round(1000 / wordsPerSec));

        this.fallbackTimer = setInterval(() => {
          if (idx >= words.length) {
            this.clearTimers();
            return;
          }
          const word       = words[idx++];
          const fullOff    = baseOffset + word.start;
          this.currentCharIndex = fullOff;
          this.onWordBoundary?.(fullOff, word.length);
        }, intervalMs);
      }, 400);

      utterance.onend = () => {
        this.clearTimers();
        resolve();
      };

      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        this.clearTimers();
        if (event.error === 'interrupted' || event.error === 'canceled') {
          resolve();
        } else {
          reject(new Error(`SpeechSynthesis error: ${event.error}`));
        }
      };

      this.synth.speak(utterance);
    });
  }

  pause(): void {
    this.synth.pause();
  }

  resume(): void {
    this.synth.resume();
  }

  stop(): void {
    this.clearTimers();
    this.synth.cancel();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private clearTimers(): void {
    if (this.fallbackTimer !== null)      { clearInterval(this.fallbackTimer);      this.fallbackTimer      = null; }
    if (this.boundaryCheckTimer !== null) { clearTimeout(this.boundaryCheckTimer);  this.boundaryCheckTimer = null; }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
