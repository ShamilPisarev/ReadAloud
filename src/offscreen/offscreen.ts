/**
 * Offscreen document — owns the Web SpeechSynthesis API.
 *
 * Lifetime: created on demand by the background service worker;
 * persists until the background explicitly closes it or the extension reloads.
 *
 * Message protocol (all messages arrive via chrome.runtime.onMessage):
 *   IN  ← background: OffscreenMessage  (SPEAK_CHUNK | PAUSE | RESUME | STOP)
 *   OUT → background: ChunkDoneMessage  (CHUNK_DONE)
 */

import { SpeechSynthesisEngine }      from '../lib/speech/speech-synthesis-engine';
import { KokoroEngine }               from '../lib/speech/kokoro-engine';
import type { EngineId, SpeechEngine, Voice } from '../lib/speech/types';
import type { OffscreenMessage }       from '../lib/messages';
import type { ChunkDoneMessage, WordBoundaryMessage } from '../lib/messages';

// ---------------------------------------------------------------------------
// Engine instance — lives for the lifetime of the document
// ---------------------------------------------------------------------------

type OffscreenEngine = SpeechEngine & {
  setRate: (rate: number) => Promise<void>;
};

const speechSynthesisEngine = new SpeechSynthesisEngine(window.speechSynthesis);
const kokoroEngine = new KokoroEngine();
let activeEngine: OffscreenEngine = speechSynthesisEngine;

/**
 * Generation counter — incremented each time a new utterance starts
 * (SPEAK_CHUNK or SET_RATE).  When the old promise resolves due to cancel /
 * interrupted, the generation has already advanced so notifyDone is skipped.
 */
let speakGeneration = 0;

// Forward word boundary events to the background service worker,
// which will relay them to the content script for real-time word highlighting.
wireWordBoundaries(speechSynthesisEngine);
wireWordBoundaries(kokoroEngine);
kokoroEngine.onModelStatus = status => {
  chrome.runtime.sendMessage({
    type: 'ENGINE_STATUS',
    engine: 'kokoro',
    status,
  }).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (rawMessage: unknown, _sender, sendResponse) => {
    const msg = rawMessage as OffscreenMessage;

    switch (msg.type) {
      case 'SPEAK_CHUNK': {
        const nextEngine = resolveEngine(msg.voiceId);
        if (nextEngine !== activeEngine) {
          activeEngine.stop();
          activeEngine = nextEngine;
        }
        const gen = ++speakGeneration;
        const engineId = activeEngine.engineId;
        activeEngine
          .speak(msg.text, {
            voiceId: msg.voiceId,
            prefetchText: msg.prefetchText,
            rate:    msg.rate,
            pitch:   msg.pitch,
            volume:  msg.volume,
            lang:    msg.lang,
          })
          .then(() => {
            if (gen === speakGeneration) notifyDone(true, engineId);
          })
          .catch((err: unknown) => {
            if (gen === speakGeneration) {
              notifyDone(
                false,
                engineId,
                err instanceof Error ? err.message : String(err),
              );
            }
          });
        sendResponse({ ok: true });
        return false;
      }

      case 'PAUSE':
        activeEngine.pause();
        sendResponse({ ok: true });
        return false;

      case 'RESUME':
        activeEngine.resume();
        sendResponse({ ok: true });
        return false;

      case 'STOP':
        // Invalidate the in-flight completion callback so cancelling an
        // utterance cannot be mistaken for a successfully finished chunk.
        ++speakGeneration;
        speechSynthesisEngine.stop();
        kokoroEngine.stop();
        sendResponse({ ok: true });
        return false;

      case 'SET_RATE': {
        const gen = ++speakGeneration;
        const engineId = activeEngine.engineId;
        activeEngine.setRate(msg.rate)
          .then(() => {
            if (gen === speakGeneration) notifyDone(true, engineId);
          })
          .catch((err: unknown) => {
            if (gen === speakGeneration) {
              notifyDone(
                false,
                engineId,
                err instanceof Error ? err.message : String(err),
              );
            }
          });
        sendResponse({ ok: true });
        return false;
      }

      case 'PRELOAD_VOICE':
        if (!msg.voiceId.startsWith('kokoro:')) {
          sendResponse({ ok: true });
          return false;
        }
        kokoroEngine.preload()
          .then(() => sendResponse({ ok: true }))
          .catch((err: unknown) => sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        return true;

      case 'GET_VOICES_REQUEST':
        // Kokoro voice metadata is available immediately; model weights are
        // downloaded only if the user explicitly selects one of those voices.
        Promise.all([
          speechSynthesisEngine.getVoices(),
          kokoroEngine.getVoices(),
        ]).then((voiceGroups: Voice[][]) => {
          sendResponse({
            ok: true,
            voices: voiceGroups.flat(),
          });
        }).catch(() => sendResponse({ ok: false }));
        return true; // keep channel open for async sendResponse
    }

    return false; // unrecognised message — do not keep channel open
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEngine(voiceId?: string): OffscreenEngine {
  return voiceId?.startsWith('kokoro:')
    ? kokoroEngine
    : speechSynthesisEngine;
}

function wireWordBoundaries(
  engine: OffscreenEngine & {
    onWordBoundary?: (charIndex: number, charLength: number) => void;
  },
): void {
  engine.onWordBoundary = (charIndex: number, charLength: number) => {
    if (engine !== activeEngine) return;
    const msg: WordBoundaryMessage = {
      type: 'WORD_BOUNDARY',
      charIndex,
      charLength,
      engine: engine.engineId,
    };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  };
}

function notifyDone(ok: boolean, engine: EngineId, error?: string): void {
  const msg: ChunkDoneMessage = { type: 'CHUNK_DONE', ok, error, engine };
  chrome.runtime.sendMessage(msg).catch(() => {
    // Background may have restarted; silently ignore.
  });
}
