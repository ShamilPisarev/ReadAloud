import type { ExtractionResult, TextNodeEntry } from './types';

// ---------------------------------------------------------------------------
// Elements to strip before reading text
// ---------------------------------------------------------------------------

const JUNK_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', '[role="complementary"]',
  '.nav', '.navigation', '.menu', '.breadcrumb',
  '.pagination', '.sidebar', '.widget',
  '.ad', '.ads', '.adsbygoogle', '.advertisement', '.promo',
  '.cookie-banner', '.cookie-notice', '.gdpr',
  '.social-share', '.share-buttons',
  'form[action*="search"]',
].join(', ');

/**
 * Ordered list of selectors used to find the main article container.
 * The first matching element wins.
 */
const ARTICLE_SELECTORS = [
  'article',
  '[role="main"]',
  'main',
  '.post-content',
  '.article-content',
  '.article-body',
  '.entry-content',
  '.story-body',
  '.post-body',
  '.content-body',
  '#content',
  '.content',
] as const;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a DOM element contributes visible text.
 * Excludes elements with `display:none` or `visibility:hidden`.
 */
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}
/**
 * Walk all `Text` nodes inside `root` in document order, calling `visitor`
 * for each node that has non-whitespace content.
 * Skips subtrees whose root element is hidden or matches junk selectors.
 */
function walkTextNodes(
  root: Node,
  visitor: (node: Text, content: string) => void,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = (node as Text).textContent ?? '';
      if (!text.trim()) return NodeFilter.FILTER_SKIP;

      // Skip nodes inside junk containers
      let ancestor = node.parentElement;
      while (ancestor && ancestor !== root) {
        if (ancestor.matches(JUNK_SELECTORS)) return NodeFilter.FILTER_SKIP;
        if (!isVisible(ancestor))             return NodeFilter.FILTER_SKIP;
        ancestor = ancestor.parentElement;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    const content  = textNode.textContent ?? '';
    if (content.trim()) visitor(textNode, content);
  }
}

/**
 * Build a flat string and a parallel `TextNodeEntry[]` from the text nodes
 * inside `root`.  A single newline is inserted between block-level siblings
 * to preserve paragraph structure.
 */
function buildFlatText(root: Element): { text: string; nodeMap: TextNodeEntry[] } {
  const nodeMap: TextNodeEntry[] = [];
  const parts:   string[]        = [];
  let   cursor   = 0;
  let   lastBlock: Element | null = null;

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH',
  ]);

  walkTextNodes(root, (node, content) => {
    // Insert newline separator between different block-level parent elements
    const blockParent = findBlockParent(node, BLOCK_TAGS);
    if (lastBlock && blockParent !== lastBlock) {
      parts.push('\n');
      cursor += 1;
    }
    lastBlock = blockParent;

    const start = cursor;
    parts.push(content);
    cursor += content.length;

    nodeMap.push({ node, start, end: cursor });
  });

  return { text: parts.join(''), nodeMap };
}

function findBlockParent(node: Node, blockTags: Set<string>): Element | null {
  let el = node.parentElement;
  while (el) {
    if (blockTags.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

function buildSelectionText(range: Range): { text: string; nodeMap: TextNodeEntry[] } {
  const nodeMap: TextNodeEntry[] = [];
  const parts: string[] = [];
  let cursor = 0;

  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      try {
        return range.intersectsNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      } catch {
        return NodeFilter.FILTER_SKIP;
      }
    },
  });

  let node: Node | null = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const fullText = textNode.textContent ?? '';
    let start = 0;
    let end = fullText.length;

    if (textNode === range.startContainer) {
      start = range.startOffset;
    }
    if (textNode === range.endContainer) {
      end = range.endOffset;
    }

    const slice = fullText.slice(start, end);
    if (slice.length > 0) {
      const sliceStart = cursor;
      parts.push(slice);
      cursor += slice.length;
      nodeMap.push({ node: textNode, start: sliceStart, end: cursor });
    }

    node = walker.nextNode();
  }

  return { text: parts.join(''), nodeMap };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the current text selection from the page.
 * Returns `null` when nothing is selected.
 */
export function extractSelection(): ExtractionResult | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const { text, nodeMap } = buildSelectionText(range);
  if (!text.trim()) return null;

  return { text, source: 'selection', nodeMap };
}

/**
 * Find the main article/content element and extract its text.
 * Returns `null` when no suitable container is found.
 */
export function extractArticle(): ExtractionResult | null {
  for (const selector of ARTICLE_SELECTORS) {
    const el = document.querySelector<Element>(selector);
    if (!el || !isVisible(el)) continue;

    // Build the node map from the live DOM so highlighting and auto-scroll
    // can target actual page nodes. Junk filtering already happens inside
    // walkTextNodes(), so no clone is needed here.
    const { text, nodeMap } = buildFlatText(el);
    if (text.trim().length < 100) continue; // too short, try next candidate

    return { text, source: 'article', nodeMap };
  }
  return null;
}

/**
 * Fall back to extracting all visible text from `<body>`.
 * Always succeeds (may return an empty string on empty pages).
 */
export function extractFallback(): ExtractionResult {
  const body = document.body;
  if (!body) return { text: '', source: 'fallback', nodeMap: [] };

  const { text, nodeMap } = buildFlatText(body);
  return { text, source: 'fallback', nodeMap };
}

/**
 * Run all extraction strategies in priority order and return the first
 * non-empty result: selection → article → fallback.
 */
export function extract(): ExtractionResult {
  return (
    extractSelection() ??
    extractArticle()   ??
    extractFallback()
  );
}

