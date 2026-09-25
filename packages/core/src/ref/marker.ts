/**
 * Live cross-document reference markers.
 *
 * A reference block lives inside a document's ordinary markdown source as a
 * single compact placeholder:
 *
 *     [[ref:ex_<id>]]
 *
 * The marker is part of the CRDT text, so it persists, merges and replicates
 * exactly like any other character run — no special op types are needed. The
 * preview layer replaces markers with the *current* content of the referenced
 * excerpt (resolved server-side); the source view keeps the compact form.
 */

export const REF_MARKER_PREFIX = '[[ref:';
export const REF_MARKER_SUFFIX = ']]';

/** Matches one reference marker; excerpt ids are `[A-Za-z0-9_-]+`. */
export const REF_MARKER_RE = /\[\[ref:([A-Za-z0-9_-]+)\]\]/g;

export interface RefMarker {
  /** Referenced excerpt id. */
  excerptId: string;
  /** Start index of the marker in the source text. */
  start: number;
  /** End index (exclusive) of the marker in the source text. */
  end: number;
}

/** Compose the marker source for an excerpt id. */
export function refMarker(excerptId: string): string {
  return `${REF_MARKER_PREFIX}${excerptId}${REF_MARKER_SUFFIX}`;
}

/** All reference markers in a source text, in document order. */
export function parseRefMarkers(text: string): RefMarker[] {
  const out: RefMarker[] = [];
  REF_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_MARKER_RE.exec(text)) !== null) {
    out.push({ excerptId: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Distinct referenced excerpt ids in a source text, in first-use order. */
export function referencedExcerptIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of parseRefMarkers(text)) {
    if (!seen.has(m.excerptId)) seen.add(m.excerptId);
  }
  return [...seen];
}
