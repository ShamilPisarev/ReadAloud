import type { Voice, EngineId } from './types';

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHT_LOCAL         = 10;   // local voices preferred but don't shadow quality
const WEIGHT_LANG_EXACT    = 40;
const WEIGHT_LANG_PREFIX   = 20;
const WEIGHT_QUALITY_KW    = 30;   // per matched keyword — quality > locality

/**
 * Keywords that signal high-quality, natural-sounding synthesis.
 * Matched case-insensitively against the voice name.
 *
 * Ordering matters only for readability here — all matches add WEIGHT_QUALITY_KW
 * each, so voices with multiple quality keywords get a cumulative bonus.
 *
 * Microsoft "Online Natural" voices (e.g. "Microsoft Jenny Online (Natural) -
 * English (United States)") will match "natural" + "online" = +60 pts, placing
 * them firmly above local Desktop voices.
 */
const QUALITY_KEYWORDS = [
  'natural',
  'neural',
  'online',
  'enhanced',
  'premium',
  'wavenet',
  'studio',
  'multilingual',
  'google',
  'siri',
  'hd',
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Unscored shape used before `rankVoices` assigns `score`. */
export type UnscoredVoice = Omit<Voice, 'score'>;

function computeScore(voice: UnscoredVoice, preferredLang?: string): number {
  let score = 0;

  if (voice.local) {
    score += WEIGHT_LOCAL;
  }

  if (preferredLang) {
    const target = preferredLang.toLowerCase();
    const vl     = voice.lang.toLowerCase();
    const prefix = target.split('-')[0];

    if (vl === target) {
      score += WEIGHT_LANG_EXACT;
    } else if (vl.startsWith(prefix) || vl === prefix) {
      score += WEIGHT_LANG_PREFIX;
    }
  }

  const nameLower = voice.name.toLowerCase();
  for (const kw of QUALITY_KEYWORDS) {
    if (nameLower.includes(kw)) {
      score += WEIGHT_QUALITY_KW;
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score and sort `voices` in descending preference order.
 *
 * @param voices       Unscored voices from an engine's discovery step.
 * @param preferredLang BCP-47 tag of the user's preferred language (optional).
 *                     When supplied, voices whose `lang` matches get a bonus.
 */
export function rankVoices(
  voices: UnscoredVoice[],
  preferredLang?: string,
): Voice[] {
  return voices
    .map(v => ({ ...v, score: computeScore(v, preferredLang) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick the single best voice from an already-ranked list for a given language.
 *
 * Tries an exact BCP-47 match first, then a prefix match, then falls back to
 * the top-ranked voice regardless of language.
 *
 * @param voices  Pre-ranked voice list (output of `rankVoices`).
 * @param lang    BCP-47 language tag to filter by (optional).
 * @param engine  Restrict to a specific engine (optional).
 */
export function pickBestVoice(
  voices: Voice[],
  lang?: string,
  engine?: EngineId,
): Voice | undefined {
  if (voices.length === 0) return undefined;

  let pool = engine ? voices.filter(v => v.engine === engine) : voices;
  if (pool.length === 0) pool = voices; // fall back to all engines

  if (!lang) return pool[0];

  const target = lang.toLowerCase();
  const prefix = target.split('-')[0];

  const exact  = pool.filter(v => v.lang.toLowerCase() === target);
  if (exact.length > 0) return exact[0];

  const byPrefix = pool.filter(v => v.lang.toLowerCase().startsWith(prefix));
  if (byPrefix.length > 0) return byPrefix[0];

  return pool[0];
}
