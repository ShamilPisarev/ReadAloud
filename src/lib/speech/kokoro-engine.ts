import { KokoroTTS, env as kokoroEnv } from 'kokoro-js';
import type { RawAudio } from '@huggingface/transformers';
import type { SpeakOptions, SpeechEngine, Voice } from './types';
import { rankVoices, type UnscoredVoice } from './voice-ranking';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_MAX_RATE = 2;

export type ModelConfig = {
  device: 'webgpu' | 'wasm';
  dtype: 'fp32' | 'fp16' | 'q8';
};

type KokoroVoiceDefinition = {
  id: string;
  name: string;
  lang: 'en-US' | 'en-GB';
};

type PreparedAudio = {
  key: string;
  promise: Promise<RawAudio>;
};

const KOKORO_VOICES = [
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
] as const satisfies readonly KokoroVoiceDefinition[];

type KokoroVoiceId = (typeof KOKORO_VOICES)[number]['id'];

/**
 * Fully local Kokoro playback. Model weights and voice tensors are fetched
 * once from Hugging Face and retained by the browser Cache API.
 */
export class KokoroEngine implements SpeechEngine {
  readonly engineId = 'kokoro' as const;

  onWordBoundary?: (charIndex: number, charLength: number) => void;
  onWordBoundarySchedule?: (
    words: Array<{ charIndex: number; charLength: number; atMs: number }>,
    durationMs: number,
  ) => void;
  onModelStatus?: (status: 'loading' | 'ready', progress?: number | null) => void;

  private modelPromise: Promise<KokoroTTS> | null = null;
  private modelReady = false;
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private boundaryTimer: ReturnType<typeof setInterval> | null = null;
  private settlePlayback: (() => void) | null = null;
  private generation = 0;
  private currentRate = 1;
  private currentText = '';
  private currentVoice: KokoroVoiceId = 'af_heart';
  private currentVolume = 1;
  private currentCharIndex = 0;
  private currentPrefetchText = '';
  private preparedAudio: PreparedAudio | null = null;
  private downloadProgress = new Map<string, { loaded: number; total: number }>();
  private lastReportedPercent = -1;
  /** Benchmark-only override for the model config (see benchGenerate). */
  private forcedConfig: ModelConfig | null = null;

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
    this.currentRate = clamp(options.rate ?? 1, 0.5, KOKORO_MAX_RATE);
    this.currentVolume = clamp(options.volume ?? 1, 0, 1);
    this.currentCharIndex = 0;
    this.currentPrefetchText = options.prefetchText ?? '';

    await this.generateAndPlay(text, 0, generation);
  }

  /** Warm the model while the user is choosing settings, before playback. */
  async preload(): Promise<void> {
    await this.getModel();
  }

  /**
   * Dev-only benchmark probe: synthesise without playback and report model
   * init time, generation time, and audio-integrity statistics so tooling
   * can compare dtypes and detect corrupted output.
   */
  async benchGenerate(
    text: string,
    voiceId?: string,
    modelConfig?: ModelConfig,
  ): Promise<Record<string, number>> {
    if (modelConfig) {
      this.forcedConfig = modelConfig;
      this.modelPromise = null;
      this.modelReady = false;
    }
    const initStart = performance.now();
    const model = await this.getModel();
    const initMs = performance.now() - initStart;

    const generateStart = performance.now();
    const audio = await model.generate(text, {
      voice: this.resolveVoice(voiceId),
      speed: 1,
    });
    const generateMs = performance.now() - generateStart;

    const samples = audio.audio;
    let sumSquares = 0;
    let peak = 0;
    let nanCount = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i] ?? 0;
      if (Number.isNaN(value)) {
        nanCount++;
        continue;
      }
      sumSquares += value * value;
      if (Math.abs(value) > peak) peak = Math.abs(value);
    }

    return {
      initMs: Math.round(initMs),
      generateMs: Math.round(generateMs),
      audioSeconds: samples.length / audio.sampling_rate,
      rms: Math.sqrt(sumSquares / Math.max(1, samples.length)),
      peak,
      nanCount,
    };
  }

  /** Regenerate the unread text at the new speed so the voice keeps its pitch. */
  async setRate(rate: number): Promise<void> {
    const nextRate = clamp(rate, 0.5, KOKORO_MAX_RATE);
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
    voice: KokoroVoiceId,
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
    voice: KokoroVoiceId,
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
      this.onModelStatus?.('loading', null);
      this.modelPromise = this.loadBestModel().then(model => {
        this.modelReady = true;
        this.onModelStatus?.('ready');
        return model;
      }).catch((error: unknown) => {
        this.modelPromise = null;
        this.modelReady = false;
        this.onModelStatus?.('ready');
        throw error;
      });
    } else if (!this.modelReady) {
      this.onModelStatus?.('loading', null);
    }
    return this.modelPromise;
  }

  private async loadBestModel(): Promise<KokoroTTS> {
    // Both WebGPU and WASM use ONNX Runtime's local JSEP module.
    // NOTE: offscreen documents only get the chrome.runtime API — no
    // chrome.storage — so the chosen config cannot be persisted here.
    kokoroEnv.wasmPaths = chrome.runtime.getURL('dist/wasm/');

    const candidates = this.forcedConfig
      ? [this.forcedConfig]
      : await defaultModelCandidates();

    let lastError: unknown = new Error('No Kokoro model configuration available.');
    for (const config of candidates) {
      try {
        return await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: config.dtype,
          device: config.device,
          progress_callback: event => this.reportDownloadProgress(event),
        });
      } catch (error) {
        lastError = error;
        console.warn(
          `Kokoro ${config.device}/${config.dtype} initialization failed.`,
          error,
        );
      }
    }
    throw lastError;
  }

  /**
   * Aggregate transformers.js per-file download events into one percentage.
   * Only real network downloads emit 'progress'; cache hits skip straight to
   * 'done', so a warm start shows no misleading progress numbers.
   */
  private reportDownloadProgress(event: unknown): void {
    const info = event as {
      status?: string;
      file?: string;
      loaded?: number;
      total?: number;
    };
    if (info.status !== 'progress' || !info.file || !info.total) return;

    this.downloadProgress.set(info.file, {
      loaded: info.loaded ?? 0,
      total: info.total,
    });
    let loaded = 0;
    let total = 0;
    for (const entry of this.downloadProgress.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    const percent = Math.min(99, Math.floor((loaded / total) * 100));
    if (percent !== this.lastReportedPercent) {
      this.lastReportedPercent = percent;
      this.onModelStatus?.('loading', percent);
    }
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
    buffer.copyToChannel(audio.audio as Float32Array<ArrayBuffer>, 0);

    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    this.source = source;
    const schedule = computeWordSchedule(text, baseOffset, buffer.duration * 1000);
    this.onWordBoundarySchedule?.(schedule, buffer.duration * 1000);
    this.startBoundaryTimer(
      schedule,
      buffer.duration,
      context,
      !this.onWordBoundarySchedule,
    );

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
    schedule: Array<{ charIndex: number; charLength: number; atMs: number }>,
    durationSeconds: number,
    context: AudioContext,
    emitBoundaries: boolean,
  ): void {
    this.clearBoundaryTimer();
    if (schedule.length === 0 || durationSeconds <= 0) return;

    const startedAt = context.currentTime;
    let lastIndex = -1;
    const update = (): void => {
      const elapsedMs = (context.currentTime - startedAt) * 1000;
      let index = Math.max(0, lastIndex);
      while (index + 1 < schedule.length && schedule[index + 1]!.atMs <= elapsedMs) {
        index++;
      }
      if (index === lastIndex) return;
      lastIndex = index;
      const word = schedule[index];
      if (word) {
        this.currentCharIndex = word.charIndex;
        if (emitBoundaries) {
          this.onWordBoundary?.(word.charIndex, word.charLength);
        }
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

  private resolveVoice(voiceId?: string): KokoroVoiceId {
    const requested = voiceId?.startsWith('kokoro:')
      ? voiceId.slice('kokoro:'.length)
      : 'af_heart';
    const voice = KOKORO_VOICES.find(candidate => candidate.id === requested);
    return voice?.id ?? 'af_heart';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function audioKey(
  text: string,
  voice: KokoroVoiceId,
  rate: number,
): string {
  return `${voice}\u0000${rate}\u0000${text}`;
}

/**
 * Estimate when each word is spoken by weighting words by their length
 * (plus one gap character), so long words hold the highlight longer than
 * short ones instead of every word getting an equal share of the clip.
 */
function computeWordSchedule(
  text: string,
  baseOffset: number,
  durationMs: number,
): Array<{ charIndex: number; charLength: number; atMs: number }> {
  const words: Array<{ charIndex: number; charLength: number }> = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    words.push({
      charIndex: baseOffset + match.index,
      charLength: match[0].length,
    });
  }

  const totalWeight = words.reduce((sum, word) => sum + word.charLength + 1, 0);
  let consumedWeight = 0;
  return words.map(word => {
    const atMs = totalWeight > 0
      ? (consumedWeight / totalWeight) * durationMs
      : 0;
    consumedWeight += word.charLength + 1;
    return { ...word, atMs };
  });
}

async function defaultModelCandidates(): Promise<ModelConfig[]> {
  // FP16 would halve the download, but on real hardware it produces metallic
  // audio that decays to silence after a few sentences — while waveform
  // statistics (RMS/peak/NaN) still look identical to FP32, so it cannot be
  // detected automatically. WebGPU must stay on FP32.
  if (await supportsFastWebGpu()) {
    return [
      { device: 'webgpu', dtype: 'fp32' },
      { device: 'wasm',   dtype: 'q8'   },
    ];
  }
  return [{ device: 'wasm', dtype: 'q8' }];
}

type WebGpuNavigator = Navigator & {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }):
      Promise<{ features: ReadonlySet<string> } | null>;
  };
};

async function supportsFastWebGpu(): Promise<boolean> {
  try {
    const adapter = await (navigator as WebGpuNavigator).gpu?.requestAdapter({
      powerPreference: 'high-performance',
    });
    return adapter?.features.has('shader-f16') ?? false;
  } catch {
    return false;
  }
}
