/**
 * Reference expansion for preview rendering.
 *
 * The source document is split at its compact markers into a tree of markdown
 * runs and reference blocks. Reference content is itself source text, so a
 * block can contain more markers (A embeds B, B embeds C); expansion follows
 * them transitively through a pure resolver supplied by the caller (the server
 * ships the resolved, permission-filtered excerpt set, the client walks it).
 *
 * Cycle rejection happens while edges are created (see graph.ts), so a valid
 * graph is always a DAG. The trail guard here is defence in depth: even if a
 * cycle slipped in, rendering degrades to a marked guard block instead of
 * overflowing the stack or self-inflating forever.
 */

import { parseRefMarkers } from './marker.js';

export const MAX_EXPAND_DEPTH = 20;

/**
 * One excerpt as resolved by the server for a particular viewer.
 * - `allowed === false`: the viewer lacks read access to the source document;
 *   real content must never be present.
 * - `status === 'invalid'`: source passage was deleted; `content` is the last
 *   seen text, shown in the degraded state.
 */
export interface ResolvedRef {
  excerptId: string;
  sourceDocId: string;
  sourceTitle: string;
  status: 'anchored' | 'invalid';
  content: string;
  allowed: boolean;
}

export type RefResolver = (excerptId: string) => ResolvedRef | undefined;

export type RenderBlock =
  | { kind: 'md'; markdown: string }
  | {
      kind: 'ref';
      ref: ResolvedRef;
      /** Expanded inner blocks; empty when forbidden/invalid/cycle-guarded. */
      blocks: RenderBlock[];
      /** Defence-in-depth: an expansion trail repeated itself. */
      cycleGuard?: boolean;
    };

/**
 * Expand every marker in `text` through `resolve`. Unknown excerpt ids become
 * invalid blocks carrying no content (the relationship itself is still shown
 * so the reference never silently vanishes).
 */
export function expandMarkdown(
  text: string,
  resolve: RefResolver,
  trail: string[] = [],
  depth = 0,
): RenderBlock[] {
  const markers = parseRefMarkers(text);
  if (markers.length === 0) {
    return text.length > 0 ? [{ kind: 'md', markdown: text }] : [];
  }
  const out: RenderBlock[] = [];
  let cursor = 0;
  for (const m of markers) {
    if (m.start > cursor) out.push({ kind: 'md', markdown: text.slice(cursor, m.start) });
    out.push(expandOne(m.excerptId, resolve, trail, depth));
    cursor = m.end;
  }
  if (cursor < text.length) out.push({ kind: 'md', markdown: text.slice(cursor) });
  return out;
}

function expandOne(
  excerptId: string,
  resolve: RefResolver,
  trail: string[],
  depth: number,
): RenderBlock {
  const ref = resolve(excerptId);
  const fallback: ResolvedRef =
    ref ?? {
      excerptId,
      sourceDocId: '',
      sourceTitle: '未知来源',
      status: 'invalid',
      content: '',
      allowed: true,
    };

  if (!fallback.allowed || fallback.status === 'invalid' || depth >= MAX_EXPAND_DEPTH) {
    return { kind: 'ref', ref: fallback, blocks: [] };
  }
  if (trail.includes(excerptId)) {
    return { kind: 'ref', ref: fallback, blocks: [], cycleGuard: true };
  }
  return {
    kind: 'ref',
    ref: fallback,
    blocks: expandMarkdown(fallback.content, resolve, [...trail, excerptId], depth + 1),
  };
}
