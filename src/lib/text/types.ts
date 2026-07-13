/** Where the text came from — determines fallback priority. */
export type ExtractionSource = 'selection' | 'article' | 'fallback';

/**
 * Maps a contiguous slice of the flat extracted string back to a live
 * DOM `Text` node, so the highlighter can build precise `Range` objects.
 *
 * Offsets are relative to `ExtractionResult.text`:
 *   `text.slice(entry.start, entry.end) === entry.node.textContent`
 */
export interface TextNodeEntry {
  node: Text;
  /** Inclusive start offset in the full text string. */
  start: number;
  /** Exclusive end offset in the full text string. */
  end: number;
}

/** Full result of a text extraction pass. */
export interface ExtractionResult {
  /** Flat, clean text ready for chunking and TTS. */
  text: string;
  /** Which extraction strategy produced this result. */
  source: ExtractionSource;
  /**
   * Ordered list of DOM text nodes that make up `text`.
   * Empty when `source === 'selection'` (Selection API handles that separately).
   */
  nodeMap: TextNodeEntry[];
}

/** A single unit of text passed to the TTS engine. */
export interface Chunk {
  /** Zero-based position in the chunk array. */
  index: number;
  /** The actual text to be spoken. */
  text: string;
  /** Start offset in `ExtractionResult.text` (inclusive). */
  startOffset: number;
  /** End offset in `ExtractionResult.text` (exclusive). */
  endOffset: number;
}
