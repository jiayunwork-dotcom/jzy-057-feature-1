/**
 * Cross-document reference dependency graph and cycle detection.
 *
 * An edge `refDoc -> sourceDoc` means "refDoc embeds a snippet registered in
 * sourceDoc". Edges are stored denormalised per snippet; the graph view is
 * derived on demand. Cycles are rejected at edge-creation time so rendering and
 * propagation can assume the document-level reference graph is always a DAG.
 */

export interface DepEdge {
  /** Document that contains the reference block. */
  refDocId: string;
  /** Document that owns the referenced snippet. */
  sourceDocId: string;
}

/** Collapse per-snippet edges to unique document-level directed edges. */
export function documentGraph(edges: DepEdge[]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!g.has(e.refDocId)) g.set(e.refDocId, new Set());
    g.get(e.refDocId)!.add(e.sourceDocId);
  }
  return g;
}

/**
 * Would adding `from -> to` close a cycle (including a self loop)?
 *
 * True iff `from === to`, or `from` is already reachable from `to` through the
 * existing edges (i.e. `to … -> from` exists). O(V+E) reachability walk.
 */
export function wouldCreateCycle(
  edges: DepEdge[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const g = documentGraph(edges);
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of g.get(cur) ?? []) stack.push(next);
  }
  return false;
}
