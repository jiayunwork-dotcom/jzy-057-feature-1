/**
 * Live-reference block markers.
 *
 * A reference block lives in the body of a document as exactly one compact
 * source line:
 *
 * ```
 * ^ref[sfr_abc123#ref_xyz789]
 * ```
 *
 * - `sfr_…` is the stable id of the registered source *snippet* (the anchor
 *   created with "登记为可引用片段").
 * - `ref_…` is this block's own instance id, so embedding the same snippet
 *   twice yields two individually addressable blocks.
 *
 * A marker is ordinary CRDT text: it moves, versions and rolls back with the
 * document body. Everything that makes it "live" — the dependency graph,
 * content resolution, cross-document propagation — lives outside the CRDT and
 * keys off the snippet id found here.
 */

const ID = '[A-Za-z0-9_-]+';
const MARKER_RE = new RegExp(`^[ \\t]*\\^ref\\[(${ID})#(${ID})\\][ \\t]*$`);
/** Find a marker anywhere in multiline text (multiline + line-anchored). */
const MARKER_GLOBAL_RE = new RegExp(`^[ \\t]*\\^ref\\[(${ID})#(${ID})\\][ \\t]*$`, 'gm');

export interface Marker {
  snippetId: string;
  blockId: string;
  /** Offset of the marker line start in the source text. */
  index: number;
  /** Offset just past the marker line end (before the terminating newline). */
  end: number;
}

/** Parse a single line as a marker, or null if it is ordinary text. */
export function parseMarkerLine(line: string): { snippetId: string; blockId: string } | null {
  const m = MARKER_RE.exec(line);
  if (!m) return null;
  return { snippetId: m[1], blockId: m[2] };
}

/** Enumerate every reference marker in a document's source text. */
export function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  MARKER_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_GLOBAL_RE.exec(text)) !== null) {
    const lineStart = m.index;
    let lineEnd = m.index + m[0].length;
    // Consume a single trailing newline as part of the block line.
    if (text[lineEnd] === '\n') lineEnd += 1;
    else if (text[lineEnd] === '\r' && text[lineEnd + 1] === '\n') lineEnd += 2;
    out.push({ snippetId: m[1], blockId: m[2], index: lineStart, end: lineEnd });
    if (m[0].length === 0) MARKER_GLOBAL_RE.lastIndex += 1;
  }
  return out;
}

/** Distinct source snippet ids referenced by a document's markers. */
export function referencedSnippetIds(text: string): string[] {
  return [...new Set(findMarkers(text).map((x) => x.snippetId))];
}

/** Serialise a reference to its compact one-line placeholder. */
export function markerLine(snippetId: string, blockId: string): string {
  return `^ref[${snippetId}#${blockId}]`;
}

export interface MarkerInsertion {
  index: number;
  delCount: number;
  inserted: string;
}

/**
 * Build the local edit that inserts a marker at `at`, making sure the marker
 * occupies a line of its own (splitting the current line when the caret sits
 * mid-line).
 */
export function buildMarkerInsertion(
  text: string,
  at: number,
  snippetId: string,
  blockId: string,
): MarkerInsertion {
  const pos = Math.max(0, Math.min(at, text.length));
  const atLineStart = pos === 0 || text[pos - 1] === '\n';
  const atLineEnd = pos === text.length || text[pos] === '\n' || text[pos] === '\r';
  const line = markerLine(snippetId, blockId);
  const inserted = `${atLineStart ? '' : '\n'}${line}${atLineEnd ? '' : '\n'}`;
  return { index: pos, delCount: 0, inserted };
}
