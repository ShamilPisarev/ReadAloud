// Speech layer — public API surface
export type { Voice, SpeakOptions, SpeechEngine, EngineId } from './types';
export type { UnscoredVoice }                               from './voice-ranking';
export { rankVoices, pickBestVoice }                        from './voice-ranking';
export { ChromeTtsEngine }                                  from './chrome-tts-engine';
export { SpeechSynthesisEngine }                            from './speech-synthesis-engine';
export { KokoroEngine }                                     from './kokoro-engine';
export { OpenRouterEngine }                                 from './openrouter-engine';
