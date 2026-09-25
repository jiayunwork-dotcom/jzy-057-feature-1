/**
 * Excerpt anchoring — the "live" end of a cross-document reference.
 *
 * An excerpt is registered against the text selected in its source document
 * (quote + index). As the source keeps being collaboratively edited the anchor
 * must:
 *
 *  - slide when text is inserted before it (still the same semantic passage);
 *  - follow the closest passage when partially rewritten;
 *  - degrade to `invalid`, keeping the last seen content, when the passage is
 *    removed wholesale (and recover if it reappears).
 *
 * Resolution is pure and reuses the same follow/lost semantics as comment
 * anchors; persistence and propagation are the server layer's job.
 */

import { resolveAnchor, type AnchorStatus } from '../anchor/anchor.js';

export type ExcerptStatus = AnchorStatus;

export interface ExcerptAnchor {
  /** Text selected when the excerpt was registered. */
  quote: string;
  /** Start index at registration / last successful resolution. */
  index: number;
  status: ExcerptStatus;
}

export interface ResolvedExcerpt extends ExcerptAnchor {
  /** Half-open character range in the current source text. */
  end: number;
  /**
   * The content viewers should see: the live passage while anchored, the last
   * seen quote when the anchor has been lost.
   */
  content: string;
}

/**
 * Resolve one excerpt anchor against the source document's current text.
 * `lastContent` is carried verbatim into the invalid state so a deleted
 * excerpt never renders as an empty block.
 */
export function resolveExcerpt(anchor: ExcerptAnchor, text: string): ResolvedExcerpt {
  const r = resolveAnchor(anchor, text);
  return {
    quote: r.quote,
    index: r.index,
    status: r.status,
    end: r.end,
    content: r.status === 'anchored' ? text.slice(r.index, r.end) : r.quote,
  };
}
