import type { Chunk, TextNodeEntry } from './types';

// The CSS Custom Highlight API (Highlight, CSS.highlights) is natively typed
// in TypeScript's lib.dom.d.ts (TS 5.4+). No augmentation needed.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGHLIGHT_NAME      = 'read-aloud-active';
const HIGHLIGHT_WORD_NAME = 'read-aloud-word';
const STYLE_ID            = 'read-aloud-highlight-style';

/**
 * CSS injected once into the page.
 * Uses `::highlight()` (CSS Custom Highlight API, Chrome 105+).
 * Falls back to the `.read-aloud-mark` class used by the DOM fallback path.
 */
const HIGHLIGHT_CSS = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: #ffe082;
  color: #000;
}
::highlight(${HIGHLIGHT_WORD_NAME}) {
  background-color: #ff6f00;
  color: #fff;
}
.read-aloud-mark {
  background-color: #ffe082 !important;
  color: #000 !important;
  border-radius: 2px;
  outline: 1px solid #f9a825;
}
.read-aloud-word {
  background-color: #ff6f00 !important;
  color: #fff !important;
  border-radius: 2px;
}
`.trim();

// ---------------------------------------------------------------------------
// Range resolution from nodeMap
// ---------------------------------------------------------------------------

function resolveNodeAndOffset(
  nodeMap: TextNodeEntry[],
  globalOffset: number,
): { node: Text; localOffset: number } | null {
  for (const entry of nodeMap) {
    if (globalOffset >= entry.start && globalOffset < entry.end) {
      return { node: entry.node, localOffset: globalOffset - entry.start };
    }
  }
  // Edge: offset sits exactly at the very end of the last node
  const last = nodeMap[nodeMap.length - 1];
  if (last && globalOffset === last.end) {
    return { node: last.node, localOffset: last.end - last.start };
  }
  return null;
}

function buildRange(nodeMap: TextNodeEntry[], chunk: Chunk): Range | null {
  if (nodeMap.length === 0) return null;

  const startPos = resolveNodeAndOffset(nodeMap, chunk.startOffset);
  const endPos   = resolveNodeAndOffset(nodeMap, chunk.endOffset);
  if (!startPos || !endPos) return null;

  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.localOffset);
    range.setEnd(endPos.node, endPos.localOffset);
    return range;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Highlight Manager
// ---------------------------------------------------------------------------

export class HighlightManager {
  private readonly useNativeApi: boolean;
  /** DOM nodes inserted by the fallback path, kept for cleanup. */
  private fallbackMarks: Element[] = [];
  private fallbackWordMark: Element | null = null;

  /** Keep the current chunk reference so word offsets can be resolved. */
  private currentChunk:   Chunk | null = null;
  private currentNodeMap: TextNodeEntry[] = [];

  /** Retained for the optional public word-scroll helper. */
  private lastWordScrollTime = 0;

  constructor() {
    this.useNativeApi = typeof CSS !== 'undefined' && !!CSS.highlights;
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  /**
   * Highlight `chunk` in the page using the nodeMap from the extraction result.
   * No-op when `nodeMap` is empty (e.g. selection-based extraction).
   */
  highlight(nodeMap: TextNodeEntry[], chunk: Chunk): void {
    this.injectStyles();
    this.clear();
    this.currentNodeMap = nodeMap;
    this.currentChunk   = chunk;
    if (nodeMap.length === 0) return;

    const range = buildRange(nodeMap, chunk);
    if (!range) return;

    if (this.useNativeApi) {
      this.applyNative(range);
    } else {
      this.applyFallback(range);
    }
  }

  /**
   * Highlight a single word within the current chunk.
   * `charIndex` and `charLength` are offsets within the chunk's own text
   * (as reported by SpeechSynthesisUtterance.onboundary).
   */
  highlightWord(charIndex: number, charLength: number): void {
    if (!this.currentChunk || this.currentNodeMap.length === 0) return;
    this.injectStyles();
    this.clearWord();

    const wordStart = this.currentChunk.startOffset + charIndex;
    const wordEnd   = wordStart + charLength;

    const wordChunk: Chunk = {
      index:       this.currentChunk.index,
      text:        this.currentChunk.text.slice(charIndex, charIndex + charLength),
      startOffset: wordStart,
      endOffset:   wordEnd,
    };

    const range = buildRange(this.currentNodeMap, wordChunk);
    if (!range) return;

    if (this.useNativeApi) {
      try {
        CSS.highlights!.set(HIGHLIGHT_WORD_NAME, new Highlight(range));
      } catch { /* ignore */ }
    } else {
      this.applyWordFallback(range);
    }

  }

  clearWord(): void {
    if (this.useNativeApi) {
      CSS.highlights?.delete(HIGHLIGHT_WORD_NAME);
    } else {
      this.fallbackWordMark?.remove();
      this.fallbackWordMark = null;
    }
  }

  /** Remove all active highlights from the page. */
  clear(): void {
    this.clearWord();
    this.currentChunk   = null;
    this.currentNodeMap = [];
    if (this.useNativeApi) {
      CSS.highlights?.delete(HIGHLIGHT_NAME);
    } else {
      this.clearFallback();
    }
  }

  /**
   * Scroll the chunk into view.
   * @param nodeMap  Same nodeMap used for highlighting.
   * @param chunk    Target chunk.
   * @param smooth   Whether to use smooth scrolling (default: `true`).
   */
  scrollTo(nodeMap: TextNodeEntry[], chunk: Chunk, smooth = true): void {
    const range = buildRange(nodeMap, chunk);
    if (!range) return;

    const el = range.startContainer.parentElement;
    if (!el) return;

    el.scrollIntoView({
      behavior: smooth ? 'smooth' : 'instant',
      block:    'center',
      inline:   'nearest',
    });
  }

  // ------------------------------------------------------------------
  // Private — word-level auto-scroll
  // ------------------------------------------------------------------

  /**
   * Smoothly scroll the page so the currently-spoken word stays in the upper
   * third of the viewport.  Throttled so rapid word events don't cause jitter.
   */
  scrollWordIntoView(range: Range): void {
    const now = Date.now();
    if (now - this.lastWordScrollTime < 600) return;

    const rect = range.getBoundingClientRect();
    if (!rect || rect.height === 0) return;

    const margin = window.innerHeight * 0.25;
    // Already comfortably visible — skip
    if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;

    this.lastWordScrollTime = now;
    const absoluteTop = window.scrollY + rect.top;
    window.scrollTo({
      top:      absoluteTop - window.innerHeight * 0.33,
      behavior: 'smooth',
    });
  }

  // ------------------------------------------------------------------
  // Private — CSS Custom Highlight API path
  // ------------------------------------------------------------------

  private applyNative(range: Range): void {
    try {
      CSS.highlights!.set(HIGHLIGHT_NAME, new Highlight(range));
    } catch {
      // Unexpected failure — try fallback
      this.applyFallback(range);
    }
  }

  // ------------------------------------------------------------------
  // Private — DOM mark-element fallback path
  // ------------------------------------------------------------------

  private applyFallback(range: Range): void {
    // Walk text nodes inside the range and wrap each with a <mark> element.
    const marks: Element[] = [];

    const startNode  = range.startContainer as Text;
    const endNode    = range.endContainer   as Text;
    const startOff   = range.startOffset;
    const endOff     = range.endOffset;

    if (startNode === endNode) {
      const mark = wrapTextSlice(startNode, startOff, endOff);
      if (mark) marks.push(mark);
    } else {
      // Wrap tail of start node
      const startMark = wrapTextSlice(startNode, startOff, startNode.length);
      if (startMark) marks.push(startMark);

      // Wrap all fully-contained text nodes between start and end
      const walker = document.createTreeWalker(
        range.commonAncestorContainer,
        NodeFilter.SHOW_TEXT,
      );
      let node: Node | null = walker.nextNode();
      while (node) {
        if (node !== startNode && node !== endNode && range.intersectsNode(node)) {
          const m = wrapTextSlice(node as Text, 0, (node as Text).length);
          if (m) marks.push(m);
        }
        node = walker.nextNode();
      }

      // Wrap head of end node
      const endMark = wrapTextSlice(endNode, 0, endOff);
      if (endMark) marks.push(endMark);
    }

    this.fallbackMarks = marks;
  }

  private clearFallback(): void {
    for (const mark of this.fallbackMarks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    this.fallbackMarks = [];
  }

  private applyWordFallback(range: Range): void {
    const startNode = range.startContainer as Text;
    const mark = wrapTextSlice(startNode, range.startOffset, range.endOffset, 'read-aloud-word');
    if (mark) this.fallbackWordMark = mark;
  }

  // ------------------------------------------------------------------
  // Style injection
  // ------------------------------------------------------------------

  private injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style   = document.createElement('style');
    style.id      = STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    (document.head ?? document.documentElement).appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Split `node` at `[start, end)` and wrap the slice in a `<mark>` element.
 * Returns the mark element, or `null` if the range is empty.
 */
function wrapTextSlice(node: Text, start: number, end: number, cls = 'read-aloud-mark'): Element | null {
  if (start >= end) return null;

  try {
    if (end < node.length) node.splitText(end);
    const target = start > 0 ? node.splitText(start) : node;

    const mark = document.createElement('mark');
    mark.className = cls;
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
    return mark;
  } catch {
    return null;
  }
}
