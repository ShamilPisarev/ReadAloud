import type { Chunk } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default maximum characters per chunk sent to TTS. Callers may pass a larger
 * limit — e.g. network engines batch more text per request to conserve
 * rate-limited API quotas.
 */
const MAX_CHUNK_CHARS = 280;

/**
 * Common abbreviations whose trailing period should not trigger a sentence
 * split. The check is intentionally conservative; a false negative only makes
 * a smaller chunk, while a false positive can make a chunk awkwardly large.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'approx', 'est',
  'vol', 'no', 'pp', 'fig', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
  'sep', 'sept', 'oct', 'nov', 'dec',
]);

type Span = {
  start: number;
  end: number;
};

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

function trimSpan(text: string, span: Span): Span | null {
  let start = span.start;
  let end = span.end;

  while (start < end && /\s/.test(text[start] ?? '')) start++;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;

  return start < end ? { start, end } : null;
}

function spanLength(span: Span): number {
  return span.end - span.start;
}

function isProtectedAbbreviation(text: string, punctIndex: number): boolean {
  const before = text.slice(0, punctIndex);
  const match = before.match(/([A-Za-z]{1,12})$/);
  return match ? ABBREVIATIONS.has(match[1].toLowerCase()) : false;
}

function isSentenceBoundary(paragraph: string, punctIndex: number, afterPunctuation: number): boolean {
  const char = paragraph[punctIndex];
  if (char === '.' && isProtectedAbbreviation(paragraph, punctIndex)) return false;

  const rest = paragraph.slice(afterPunctuation);
  const nextMatch = rest.match(/\S/);
  if (!nextMatch) return true;

  const next = nextMatch[0];
  return /[A-Z0-9"'(\[]/.test(next);
}

// ---------------------------------------------------------------------------
// Sentence and long-span splitting
// ---------------------------------------------------------------------------

function splitSentenceSpans(text: string, paragraph: Span): Span[] {
  const paraText = text.slice(paragraph.start, paragraph.end);
  const spans: Span[] = [];
  let sentenceStart = 0;

  const punctuation = /[.!?]+|[.]{3}/g;
  let match: RegExpExecArray | null;

  while ((match = punctuation.exec(paraText)) !== null) {
    let end = match.index + match[0].length;

    while (end < paraText.length && /["')\]]/.test(paraText[end] ?? '')) {
      end++;
    }

    if (!isSentenceBoundary(paraText, match.index, end)) {
      continue;
    }

    const trimmed = trimSpan(text, {
      start: paragraph.start + sentenceStart,
      end: paragraph.start + end,
    });
    if (trimmed) spans.push(trimmed);

    sentenceStart = end;
  }

  const finalSpan = trimSpan(text, {
    start: paragraph.start + sentenceStart,
    end: paragraph.end,
  });
  if (finalSpan) spans.push(finalSpan);

  return spans;
}

function breakLongSpan(text: string, span: Span, maxChars: number): Span[] {
  if (spanLength(span) <= maxChars) return [span];

  const result: Span[] = [];
  let start = span.start;

  while (span.end - start > maxChars) {
    let splitAt = start + maxChars;
    while (splitAt > start && !/\s/.test(text[splitAt] ?? '')) {
      splitAt--;
    }
    if (splitAt <= start) splitAt = start + maxChars;

    const piece = trimSpan(text, { start, end: splitAt });
    if (piece) result.push(piece);
    start = splitAt;
  }

  const tail = trimSpan(text, { start, end: span.end });
  if (tail) result.push(tail);
  return result;
}

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

/**
 * Convert a flat extracted string into ordered chunks while preserving exact
 * offsets into that string. Chunk text is always `text.slice(startOffset,
 * endOffset)`, which keeps word-boundary highlighting aligned with the DOM.
 */
export function createChunks(
  text: string,
  maxChars: number = MAX_CHUNK_CHARS,
): Chunk[] {
  const chunks: Chunk[] = [];
  const spans: Span[] = [];
  const paragraphRegex = /[^\n]+/g;
  let paragraphMatch: RegExpExecArray | null;

  while ((paragraphMatch = paragraphRegex.exec(text)) !== null) {
    const paragraph = trimSpan(text, {
      start: paragraphMatch.index,
      end: paragraphMatch.index + paragraphMatch[0].length,
    });
    if (!paragraph) continue;

    for (const sentence of splitSentenceSpans(text, paragraph)) {
      spans.push(...breakLongSpan(text, sentence, maxChars));
    }
  }

  let current: Span | null = null;

  const flush = (): void => {
    if (!current) return;
    chunks.push({
      index: chunks.length,
      text: text.slice(current.start, current.end),
      startOffset: current.start,
      endOffset: current.end,
    });
    current = null;
  };

  for (const span of spans) {
    if (!current) {
      current = { ...span };
      continue;
    }

    // Keep the first chunk to a single sentence so the engine synthesises it
    // quickly and speech starts sooner; later chunks merge sentences up to
    // maxChars as before.
    const mergedLength = span.end - current.start;
    if (chunks.length > 0 && mergedLength <= maxChars) {
      current.end = span.end;
      continue;
    }

    flush();
    current = { ...span };
  }

  flush();
  return chunks;
}

/**
 * Return the chunk that contains `offset` (in the original text string).
 * Returns `undefined` if offset is out of range.
 */
export function chunkAtOffset(chunks: Chunk[], offset: number): Chunk | undefined {
  return chunks.find(c => offset >= c.startOffset && offset < c.endOffset);
}
