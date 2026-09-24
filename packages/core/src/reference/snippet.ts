/**
 * Snippet anchoring: making a registered source snippet follow semantic
 * content instead of a fixed character interval.
 *
 * This mirrors the "quote + position" strategy of comment anchors but has
 * reference-specific needs, so it intentionally does NOT reuse the comment
 * matcher:
 *
 *  - a reference must surface the *rewritten* text, so the fuzzy scan prefers
 *    windows of the quote's own length (a substitution should adopt the new
 *    characters, not silently shrink the range);
 *  - the resolved slice becomes the snippet's new canonical quote, letting it
 *    keep tracking through repeated partial edits;
 *  - when the quote disappears wholesale the snippet goes `lost` and keeps its
 *    last-known content — reference blocks degrade instead of disappearing;
 *  - a lost snippet re-resolves automatically if the text reappears.
 */

import { similarity } from '../anchor/anchor.js';

export type SnippetStatus = 'anchored' | 'lost';

export interface SnippetAnchor {
  /** Last-known source text of the snippet (the registered selection). */
  quote: string;
  /** Position at creation / last successful resolution. */
  index: number;
  status: SnippetStatus;
}

export interface ResolvedSnippet extends SnippetAnchor {
  /** Half-open range in the current source text (=== index when lost). */
  end: number;
  /** The verbatim content reference blocks should render right now. */
  content: string;
}

const SEARCH_WINDOW = 400; // chars either side of the old position
const MIN_SCORE = 0.6;

function lost(s: SnippetAnchor): ResolvedSnippet {
  return { ...s, status: 'lost', end: s.index, content: s.quote };
}

function nearestOccurrence(text: string, q: string, near: number): number {
  let best = -1;
  let bestDist = Infinity;
  let from = 0;
  while (from <= text.length - q.length) {
    const at = text.indexOf(q, from);
    if (at < 0) break;
    const dist = Math.abs(at - near);
    if (dist < bestDist) {
      bestDist = dist;
      best = at;
    }
    from = at + 1;
  }
  return best;
}

/**
 * Find the best-matching window near the old position. Windows of exactly the
 * quote's length are evaluated first (substitutions / single-char edits keep
 * the range stable); adjacent lengths are only considered when no same-length
 * window clears the threshold (handles insertions/deletions inside the quote).
 */
function bestWindow(text: string, q: string, near: number): { index: number; length: number } | null {
  const from = Math.max(0, near - SEARCH_WINDOW);
  const to = Math.min(text.length, near + SEARCH_WINDOW);
  let best = -1;
  let bestLen = q.length;
  let bestScore = MIN_SCORE;

  const scan = (lengths: number[]): boolean => {
    for (let i = from; i < to; i++) {
      for (const len of lengths) {
        if (len <= 0 || i + len > text.length) continue;
        const score = similarity(q, text.substr(i, len));
        if (score > bestScore) {
          bestScore = score;
          best = i;
          bestLen = len;
        }
      }
    }
    return best >= 0;
  };

  if (scan([q.length])) return { index: best, length: bestLen };
  if (scan([q.length + 1, q.length - 1, q.length + 2, q.length - 2])) {
    return { index: best, length: bestLen };
  }
  return null;
}

/** Re-resolve one snippet against the current source document text. */
export function resolveSnippet(snippet: SnippetAnchor, text: string): ResolvedSnippet {
  const q = snippet.quote;
  if (q.length === 0) return lost(snippet);

  // 1. Nothing moved.
  if (text.substr(snippet.index, q.length) === q) {
    return { quote: q, index: snippet.index, status: 'anchored', end: snippet.index + q.length, content: q };
  }

  // 2. Moved verbatim (including a previously-lost snippet reappearing).
  const exact = nearestOccurrence(text, q, snippet.index);
  if (exact >= 0) {
    return { quote: q, index: exact, status: 'anchored', end: exact + q.length, content: q };
  }

  if (snippet.status === 'lost') return lost(snippet);

  // 3. Partial rewrite: follow the closest window and adopt its current text.
  const win = bestWindow(text, q, snippet.index);
  if (win) {
    const end = win.index + win.length;
    const content = text.slice(win.index, end);
    return { quote: content, index: win.index, status: 'anchored', end, content };
  }

  // 4. Removed wholesale — keep the last content, flag the broken reference.
  return lost(snippet);
}

/** Batch resolve; the caller persists the adopted quotes/indices. */
export function resolveSnippets(
  snippets: SnippetAnchor[],
  text: string,
): ResolvedSnippet[] {
  return snippets.map((s) => resolveSnippet(s, text));
}
