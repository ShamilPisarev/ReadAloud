import type { Voice, SpeakOptions, SpeechEngine } from './types';
import { rankVoices, type UnscoredVoice } from './voice-ranking';

/**
 * SpeechEngine backed by `chrome.tts`.
 *
 * Available in: background service worker, popup, options page.
 * NOT available in: offscreen documents, content scripts.
 *
 * Rate/pitch/volume use the chrome.tts scale:
 *   rate  → 0.1 – 10  (1 = normal)
 *   pitch → 0 – 2     (1 = normal)
 *   volume → 0 – 1    (1 = full)
 */
export class ChromeTtsEngine implements SpeechEngine {
  readonly engineId = 'chrome-tts' as const;

  /** Callback fired for each spoken word boundary. */
  onWordBoundary?: (charIndex: number, charLength: number) => void;

  private currentText = '';
  private currentOptions: SpeakOptions = {};
  private currentCharIndex = 0;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private boundaryCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private finishGuardTimer: ReturnType<typeof setTimeout> | null = null;
  private hasBoundaryEvent = false;
  private timerGeneration = 0;

  // -------------------------------------------------------------------------
  // Voice discovery
  // -------------------------------------------------------------------------

  async getVoices(): Promise<Voice[]> {
    return new Promise<Voice[]>(resolve => {
      chrome.tts.getVoices(rawVoices => {
        const unscored: UnscoredVoice[] = rawVoices
          .filter((v): v is chrome.tts.TtsVoice & { voiceName: string } =>
            v.voiceName != null,
          )
          .map(v => ({
            id:     `chrome-tts:${v.voiceName}`,
            name:   v.voiceName,
            lang:   v.lang ?? '',
            // chrome.tts marks remote voices explicitly; treat unknown as local
            local:  v.remote !== true,
            engine: 'chrome-tts' as const,
          }));

        resolve(rankVoices(unscored));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  speak(text: string, options: SpeakOptions = {}): Promise<void> {
    this.currentText = '';
    this.currentCharIndex = 0;
    this.timerGeneration++;
    this.clearTimers();
    this.currentText = text;
    this.currentOptions = options;
    return this.speakFrom(text, options, 0);
  }

  /**
   * Restart the current utterance at a new rate from the last reported word.
   * This mirrors Edge-style speed changes without waiting for the next chunk.
   */
  setRate(rate: number): Promise<void> {
    if (!this.currentText) return Promise.resolve();
    this.currentOptions = { ...this.currentOptions, rate };

    const restartAt = Math.max(0, Math.min(this.currentCharIndex, this.currentText.length));
    const remaining = this.currentText.slice(restartAt);
    if (!remaining.trim()) return Promise.resolve();

    chrome.tts.stop();
    this.clearTimers();
    return this.speakFrom(remaining, this.currentOptions, restartAt);
  }

  private speakFrom(text: string, options: SpeakOptions, baseOffset: number): Promise<void> {
    const words = collectWords(text);
    this.hasBoundaryEvent = false;
    const timerGeneration = ++this.timerGeneration;

    return new Promise<void>((resolve, reject) => {
      const engine = this;
      let settled = false;

      const settle = (ok: boolean, error?: string): void => {
        if (settled) return;
        settled = true;
        if (timerGeneration === this.timerGeneration) {
          this.clearTimers();
        }
        if (ok) {
          resolve();
        } else {
          reject(new Error(error ?? 'chrome.tts error'));
        }
      };

      const ttsOptions: chrome.tts.SpeakOptions = {
        rate:   clamp(options.rate   ?? 1, 0.1, 10),
        pitch:  clamp(options.pitch  ?? 1, 0,   2),
        volume: clamp(options.volume ?? 1, 0,   1),
        lang:   options.lang,
        desiredEventTypes: ['start', 'end', 'word', 'interrupted', 'cancelled', 'error'],

        onEvent(event: chrome.tts.TtsEvent) {
          switch (event.type) {
            case 'word': {
              if (timerGeneration !== engine.timerGeneration) break;
              const localIndex = event.charIndex ?? 0;
              const length = event.length && event.length > 0
                ? event.length
                : nextWordLength(text, localIndex);
              const fullIndex = baseOffset + localIndex;
              engine.currentCharIndex = fullIndex;
              engine.hasBoundaryEvent = true;
              engine.clearBoundaryFallback();
              engine.onWordBoundary?.(fullIndex, length);
              break;
            }
            case 'end':
              settle(true);
              break;
            case 'interrupted':
            case 'cancelled':
              settle(false, `chrome.tts ${event.type}`);
              break;
            case 'error':
              settle(false, event.errorMessage);
              break;
          }
        },
      };

      if (options.voiceId?.startsWith('chrome-tts:')) {
        ttsOptions.voiceName = options.voiceId.slice('chrome-tts:'.length);
      }

      this.startBoundaryFallback(words, options.rate ?? 1, baseOffset, timerGeneration);
      this.finishGuardTimer = setTimeout(() => settle(true), estimateMaxDurationMs(text, options.rate ?? 1));

      chrome.tts.speak(text, ttsOptions, () => {
        if (chrome.runtime.lastError) {
          settle(false, chrome.runtime.lastError.message);
        }
      });
    });
  }

  pause(): void {
    chrome.tts.pause();
  }

  resume(): void {
    chrome.tts.resume();
  }

  stop(): void {
    this.currentText = '';
    this.currentCharIndex = 0;
    this.timerGeneration++;
    this.clearTimers();
    chrome.tts.stop();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private startBoundaryFallback(
    words: Array<{ start: number; length: number }>,
    rate: number,
    baseOffset: number,
    timerGeneration: number,
  ): void {
    this.boundaryCheckTimer = setTimeout(() => {
      this.boundaryCheckTimer = null;
      if (timerGeneration !== this.timerGeneration) return;
      if (this.hasBoundaryEvent || words.length === 0) return;

      let idx = 0;
      const wordsPerSec = Math.max(1, 2.6 * rate);
      const intervalMs = Math.max(75, Math.round(1000 / wordsPerSec));

      this.fallbackTimer = setInterval(() => {
        if (timerGeneration !== this.timerGeneration) {
          this.clearBoundaryFallback();
          return;
        }
        const word = words[idx++];
        if (!word) {
          this.clearBoundaryFallback();
          return;
        }
        const fullIndex = baseOffset + word.start;
        this.currentCharIndex = fullIndex;
        this.onWordBoundary?.(fullIndex, word.length);
      }, intervalMs);
    }, 500);
  }

  private clearBoundaryFallback(): void {
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.boundaryCheckTimer !== null) {
      clearTimeout(this.boundaryCheckTimer);
      this.boundaryCheckTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearBoundaryFallback();
    if (this.finishGuardTimer !== null) {
      clearTimeout(this.finishGuardTimer);
      this.finishGuardTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function collectWords(text: string): Array<{ start: number; length: number }> {
  const words: Array<{ start: number; length: number }> = [];
  const wordRegex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRegex.exec(text)) !== null) {
    words.push({ start: match.index, length: match[0].length });
  }
  return words;
}

function nextWordLength(text: string, charIndex: number): number {
  const match = text.slice(charIndex).match(/^\S+/);
  return match ? match[0].length : 1;
}

function estimateMaxDurationMs(text: string, rate: number): number {
  const wordCount = collectWords(text).length;
  const wordsPerMinute = Math.max(70, 190 * Math.max(0.5, rate));
  const estimated = (wordCount / wordsPerMinute) * 60_000;
  return Math.max(20_000, Math.min(90_000, estimated + 12_000));
}
