/**
 * Cross-document reference dependency graph.
 *
 * Nodes are documents. An edge `from -> to` means `from`'s body embeds a live
 * reference to an excerpt defined in `to`. The graph is reconstructed from
 * persisted edges on boot and mutated incrementally; it only answers graph
 * questions — it knows nothing about websockets, permissions or rendering.
 *
 * Cycle detection happens *before* an edge is committed: a reference that
 * would close a loop (directly or transitively) is refused at creation time,
 * rather than blowing up later inside recursive rendering/propagation.
 */

export class ReferenceGraph {
  /** from doc -> set of referenced docs */
  private readonly out = new Map<string, Set<string>>();
  /** referenced doc -> set of referencing docs (for propagation fan-out) */
  private readonly inn = new Map<string, Set<string>>();

  setEdges(from: string, targets: Iterable<string>): void {
    const next = new Set<string>();
    for (const t of targets) if (t !== from) next.add(t);
    const prev = this.out.get(from);
    if (prev) {
      for (const t of prev) {
        if (!next.has(t)) this.inn.get(t)?.delete(from);
      }
    }
    for (const t of next) {
      let inSet = this.inn.get(t);
      if (!inSet) {
        inSet = new Set();
        this.inn.set(t, inSet);
      }
      inSet.add(from);
    }
    if (next.size > 0) this.out.set(from, next);
    else this.out.delete(from);
  }

  targetsOf(from: string): string[] {
    return [...(this.out.get(from) ?? [])];
  }

  /** Documents that reference `target` directly — the first hop of fan-out. */
  directReferrers(target: string): string[] {
    return [...(this.inn.get(target) ?? [])];
  }

  /** All documents that reference `target`, directly or transitively. */
  allReferrers(target: string): string[] {
    const seen = new Set<string>();
    const queue = [target];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const r of this.inn.get(cur) ?? []) {
        if (!seen.has(r)) {
          seen.add(r);
          queue.push(r);
        }
      }
    }
    return [...seen];
  }

  /**
   * Would adding `from -> to` (while keeping every other existing edge) create
   * a directed cycle? True iff `from` is already reachable from `to`, or the
   * edge is a self loop.
   */
  wouldCycle(from: string, to: string): boolean {
    if (from === to) return true;
    return this.reaches(to, from);
  }

  /** True iff a directed path `from -> ... -> target` exists. */
  reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      for (const n of this.out.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return false;
  }
}
