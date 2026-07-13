import { KokoroTTS, env as kokoroEnv } from 'kokoro-js';
import type { RawAudio } from '@huggingface/transformers';
import type { SpeakOptions, SpeechEngine, Voice } from './types';
import { rankVoices, type UnscoredVoice } from './voice-ranking';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type KokoroVoiceDefinition = {
  id: string;
  name: string;
  lang: 'en-US' | 'en-GB';
};

type PreparedAudio = {
  key: string;
  promise: Promise<RawAudio>;
};

const KOKORO_VOICES: readonly KokoroVoiceDefinition[] = [
  { id: 'af_heart',    name: 'Heart',    lang: 'en-US' },
  { id: 'af_bella',    name: 'Bella',    lang: 'en-US' },
  { id: 'af_nicole',   name: 'Nicole',   lang: 'en-US' },
  { id: 'af_aoede',    name: 'Aoede',    lang: 'en-US' },
  { id: 'af_kore',     name: 'Kore',     lang: 'en-US' },
  { id: 'af_sarah',    name: 'Sarah',    lang: 'en-US' },
  { id: 'af_alloy',    name: 'Alloy',    lang: 'en-US' },
  { id: 'af_jessica',  name: 'Jessica',  lang: 'en-US' },
  { id: 'af_nova',     name: 'Nova',     lang: 'en-US' },
  { id: 'af_river',    name: 'River',    lang: 'en-US' },
  { id: 'af_sky',      name: 'Sky',      lang: 'en-US' },
  { id: 'am_fenrir',   name: 'Fenrir',   lang: 'en-US' },
  { id: 'am_michael',  name: 'Michael',  lang: 'en-US' },
  { id: 'am_adam',     name: 'Adam',     lang: 'en-US' },
  { id: 'am_echo',     name: 'Echo',     lang: 'en-US' },
  { id: 'am_eric',     name: 'Eric',     lang: 'en-US' },
  { id: 'am_liam',     name: 'Liam',     lang: 'en-US' },
  { id: 'am_onyx',     name: 'Onyx',     lang: 'en-US' },
  { id: 'am_puck',     name: 'Puck',     lang: 'en-US' },
  { id: 'am_santa',    name: 'Santa',    lang: 'en-US' },
  { id: 'bf_emma',     name: 'Emma',     lang: 'en-GB' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'en-GB' },
  { id: 'bf_alice',    name: 'Alice',    lang: 'en-GB' },
  { id: 'bf_lily',     name: 'Lily',     lang: 'en-GB' },
  { id: 'bm_fable',    name: 'Fable',    lang: 'en-GB' },
  { id: 'bm_george',   name: 'George',   lang: 'en-GB' },
  { id: 'bm_daniel',   name: 'Daniel',   lang: 'en-GB' },
  { id: 'bm_lewis',    name: 'Lewis',    lang: 'en-GB' },
] as const;

/**
 * Fully local Kokoro playback. Model weights and voice tensors are fetched
 * once from Hugging Face and retained by the browser Cache API.
 */
export class KokoroEngine implements SpeechEngine {
  readonly engineId = 'kokoro' as const;

  onWordBoundary?: (charIndex: number, charLength: number) => void;
  onModelStatus?: (status: 'loading' | 'ready') => void;

  private modelPromise: Promise<KokoroTTS> | null = null;
  private modelReady = false;
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private boundaryTimer: ReturnType<typeof setInterval> | null = null;
  private settlePlayback: (() => void) | null = null;
  private generation = 0;
  private currentRate = 1;
  private currentText = '';
  private currentVoice: keyof KokoroTTS['voices'] = 'af_heart';
  private currentVolume = 1;
  private currentCharIndex = 0;
  private currentPrefetchText = '';
  private preparedAudio: PreparedAudio | null = null;

  getVoices(): Promise<Voice[]> {
    const voices: UnscoredVoice[] = KOKORO_VOICES.map(voice => ({
      id: `kokoro:${voice.id}`,
      name: `${voice.name} — Kokoro`,
      lang: voice.lang,
      local: true,
      engine: 'kokoro',
    }));
    return Promise.resolve(rankVoices(voices));
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    // Preserve a matching look-ahead render when moving to the next chunk.
    ++this.generation;
    this.stopAudioOnly();
    const generation = this.generation;
    this.currentText = text;
    this.currentVoice = this.resolveVoice(options.voiceId);
    this.currentRate = clamp(options.rate ?? 1, 0.5, 4);
    this.currentVolume = clamp(options.volume ?? 1, 0, 1);
    this.currentCharIndex = 0;
    this.currentPrefetchText = options.prefetchText ?? '';

    await this.generateAndPlay(text, 0, generation);
  }

  /** Warm the model while the user is choosing settings, before playback. */
  async preload(): Promise<void> {
    await this.getModel();
  }

  /** Regenerate the unread text at the new speed so the voice keeps its pitch. */
  async setRate(rate: number): Promise<void> {
    const nextRate = clamp(rate, 0.5, 4);
    this.currentRate = nextRate;
    this.preparedAudio = null;
    if (!this.currentText) return;

    let restartAt = this.currentCharIndex;
    while (/\s/.test(this.currentText.charAt(restartAt))) restartAt += 1;
    const remainingText = this.currentText.slice(restartAt);
    if (!remainingText) return;

    const generation = ++this.generation;
    this.stopAudioOnly();
    await this.generateAndPlay(remainingText, restartAt, generation);
  }

  pause(): void {
    this.audioContext?.suspend().catch(() => undefined);
  }

  resume(): void {
    this.audioContext?.resume().catch(() => undefined);
  }

  stop(): void {
    ++this.generation;
    this.stopAudioOnly();
    this.currentText = '';
    this.currentCharIndex = 0;
    this.currentPrefetchText = '';
    this.preparedAudio = null;
  }

  private stopAudioOnly(): void {
    this.clearBoundaryTimer();
    const source = this.source;
    this.source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    }
    this.finishPlayback();
  }

  private async generateAndPlay(
    text: string,
    baseOffset: number,
    generation: number,
  ): Promise<void> {
    const audio = await this.getAudio(text, this.currentVoice, this.currentRate);
    if (generation !== this.generation) return;

    await this.playAudio(
      audio,
      text,
      this.currentVolume,
      generation,
      baseOffset,
      () => {
        if (generation !== this.generation) return;
        this.prepareAudio(
          this.currentPrefetchText,
          this.currentVoice,
          this.currentRate,
        );
      },
    );
  }

  private async getAudio(
    text: string,
    voice: keyof KokoroTTS['voices'],
    rate: number,
  ): Promise<RawAudio> {
    const key = audioKey(text, voice, rate);
    if (this.preparedAudio?.key === key) {
      const prepared = this.preparedAudio;
      this.preparedAudio = null;
      return prepared.promise;
    }

    this.preparedAudio = null;
    const model = await this.getModel();
    return model.generate(text, { voice, speed: rate });
  }

  private prepareAudio(
    text: string,
    voice: keyof KokoroTTS['voices'],
    rate: number,
  ): void {
    if (!text) return;
    const key = audioKey(text, voice, rate);
    if (this.preparedAudio?.key === key) return;

    const prepared: PreparedAudio = {
      key,
      promise: this.getModel().then(model => model.generate(text, {
        voice,
        speed: rate,
      })),
    };
    this.preparedAudio = prepared;
    prepared.promise.catch(() => {
      if (this.preparedAudio === prepared) this.preparedAudio = null;
    });
  }

  private async getModel(): Promise<KokoroTTS> {
    if (!this.modelPromise) {
      kokoroEnv.wasmPaths = chrome.runtime.getURL('dist/wasm/');
      this.onModelStatus?.('loading');
      this.modelPromise = KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
      }).then(model => {
        this.modelReady = true;
        this.onModelStatus?.('ready');
        return model;
      }).catch((error: unknown) => {
        this.modelPromise = null;
        this.modelReady = false;
        throw error;
      });
    } else if (!this.modelReady) {
      this.onModelStatus?.('loading');
    }
    return this.modelPromise;
  }

  private async playAudio(
    audio: RawAudio,
    text: string,
    volume: number,
    generation: number,
    baseOffset: number,
    onStarted?: () => void,
  ): Promise<void> {
    const context = this.audioContext ?? new AudioContext();
    this.audioContext = context;
    await context.resume();
    if (generation !== this.generation) return;

    const buffer = context.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buffer.copyToChannel(Float32Array.from(audio.audio), 0);

    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    this.source = source;
    this.startBoundaryTimer(text, buffer.duration, context, baseOffset);

    return new Promise(resolve => {
      this.settlePlayback = resolve;
      source.onended = () => {
        if (generation !== this.generation) return;
        this.source = null;
        this.currentCharIndex = this.currentText.length;
        this.clearBoundaryTimer();
        this.finishPlayback();
      };
      source.start();
      onStarted?.();
    });
  }

  private startBoundaryTimer(
    text: string,
    durationSeconds: number,
    context: AudioContext,
    baseOffset: number,
  ): void {
    this.clearBoundaryTimer();
    const words: Array<{ start: number; length: number }> = [];
    const regex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      words.push({ start: match.index, length: match[0].length });
    }
    if (words.length === 0 || durationSeconds <= 0) return;

    const startedAt = context.currentTime;
    let lastIndex = -1;
    const update = (): void => {
      const progress = Math.min(0.999, (context.currentTime - startedAt) / durationSeconds);
      const index = Math.min(words.length - 1, Math.floor(progress * words.length));
      if (index === lastIndex) return;
      lastIndex = index;
      const word = words[index];
      if (word) {
        this.currentCharIndex = baseOffset + word.start;
        this.onWordBoundary?.(baseOffset + word.start, word.length);
      }
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

  private finishPlayback(): void {
    const settle = this.settlePlayback;
    this.settlePlayback = null;
    settle?.();
  }

  private resolveVoice(voiceId?: string): keyof KokoroTTS['voices'] {
    const requested = voiceId?.startsWith('kokoro:')
      ? voiceId.slice('kokoro:'.length)
      : 'af_heart';
    const voice = KOKORO_VOICES.find(candidate => candidate.id === requested);
    return (voice?.id ?? 'af_heart') as keyof KokoroTTS['voices'];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function audioKey(
  text: string,
  voice: keyof KokoroTTS['voices'],
  rate: number,
): string {
  return `${voice}\u0000${rate}\u0000${text}`;
}
