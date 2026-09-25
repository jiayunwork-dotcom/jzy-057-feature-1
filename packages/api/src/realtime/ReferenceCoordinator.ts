import {
  ReferenceGraph,
  idKey,
  referencedExcerptIds,
  resolveExcerpt,
  type Id,
} from '@collabmd/core';
import { repo, type ExcerptRow } from '../repo.js';
import type { DocumentRoom } from './DocumentRoom.js';

/**
 * Resolve an excerpt row against its source room.
 *
 * Primary anchor: the CRDT character ids of the passage's first/last
 * characters. They are immune to shifts (insertions anywhere before the
 * passage) and to interior rewrites (the boundary characters survive), so the
 * resolved range is exact — referrers see the passage verbatim.
 *
 * Fallback: when a boundary character itself was deleted, follow the quote
 * with the fuzzy matcher (same semantics as comment anchors) and adopt fresh
 * boundary ids. When the passage is gone wholesale the row degrades to lost
 * and keeps its last seen content.
 */
export interface RowResolution {
  index: number;
  end: number;
  status: 'anchored' | 'lost';
  /** Live passage while anchored; last seen content when lost. */
  content: string;
  startId: Id | null;
  endId: Id | null;
}

export function resolveExcerptRow(
  row: Pick<ExcerptRow, 'quote' | 'anchor_idx' | 'status' | 'start_id' | 'end_id' | 'last_content'>,
  room: DocumentRoom,
): RowResolution {
  const text = room.text();
  const ids = room.doc.visibleIds();
  const si = row.start_id ? ids.findIndex((id) => idKey(id) === idKey(row.start_id!)) : -1;
  const ei = row.end_id ? ids.findIndex((id) => idKey(id) === idKey(row.end_id!)) : -1;
  if (si >= 0 && ei >= si) {
    return {
      index: si,
      end: ei + 1,
      status: 'anchored',
      content: text.slice(si, ei + 1),
      startId: row.start_id,
      endId: row.end_id,
    };
  }
  const r = resolveExcerpt(
    { quote: row.quote, index: row.anchor_idx, status: row.status },
    text,
  );
  if (r.status === 'anchored') {
    return {
      index: r.index,
      end: r.end,
      status: 'anchored',
      content: r.content,
      startId: ids[r.index] ?? null,
      endId: r.end > r.index ? (ids[r.end - 1] ?? null) : null,
    };
  }
  return {
    index: r.index,
    end: r.end,
    status: 'lost',
    content: row.last_content,
    startId: null,
    endId: null,
  };
}

const sameId = (a: Id | null, b: Id | null): boolean =>
  a === b || (a !== null && b !== null && idKey(a) === idKey(b));

/**
 * The cross-document reference layer.
 *
 * Single-document collaboration (DocumentRoom) stays the authority over one
 * document's converged text. This module sits *above* the rooms and owns
 * everything that crosses document boundaries:
 *
 *  - dependency state: which document references which excerpt (in-memory
 *    graph + reverse maps, rebuilt from Postgres on boot, reconciled from the
 *    markers actually present in each body after every accepted edit);
 *  - anchor following: re-resolving excerpts against their source room's text
 *    and persisting movements;
 *  - propagation: emitting targeted change events naming exactly the documents
 *    whose rendered references are affected — never a broadcast;
 *  - per-viewer snapshots: resolving a document's (transitive) reference set
 *    with the viewer's permissions applied, so forbidden content never leaves
 *    the server.
 *
 * The realtime gateway subscribes to these events and pushes fresh snapshots
 * over the existing per-document websocket sessions.
 */

export interface RefState {
  excerptId: string;
  sourceDocId: string;
  sourceTitle: string;
  status: 'anchored' | 'invalid';
  /** Empty unless the viewer may read the source document. */
  content: string;
  allowed: boolean;
}

export type RefsEvent = {
  type: 'refs-changed';
  /** Documents whose open sessions should receive a fresh snapshot. */
  docIds: string[];
};

type Listener = (ev: RefsEvent) => void;

const ROLE_CACHE_TTL_MS = 3_000;

class ReferenceCoordinator {
  private graph = new ReferenceGraph();
  /** doc -> excerpts its body currently references */
  private docEdges = new Map<string, Set<string>>();
  /** excerpt -> docs referencing it */
  private excerptReferrers = new Map<string, Set<string>>();
  /** excerpt -> its source doc */
  private excerptDoc = new Map<string, string>();
  /** docs that define at least one live excerpt (cheap sync guard) */
  private excerptDocs = new Set<string>();
  /** per-doc registration epoch, guards async excerptDocs pruning */
  private registrationEpoch = new Map<string, number>();

  private readonly listeners = new Set<Listener>();
  private readonly attached = new Set<string>();
  private readonly syncs = new Map<string, Promise<void>>();
  private readonly roleCache = new Map<string, { ok: boolean; at: number }>();
  private ready: Promise<void> | null = null;

  // ---- lifecycle ----------------------------------------------------------

  /** Rebuild in-memory dependency state from the persisted edges. */
  private async init(): Promise<void> {
    const [edges, excerpts] = await Promise.all([
      repo.listAllEdges(),
      repo.listAllExcerpts(),
    ]);
    for (const e of excerpts) {
      this.excerptDoc.set(e.id, e.doc_id);
      if (!e.deleted) this.excerptDocs.add(e.doc_id);
    }
    const byDoc = new Map<string, Set<string>>();
    for (const edge of edges) {
      const src = this.excerptDoc.get(edge.excerpt_id);
      if (!src) continue;
      addTo(byDoc, edge.doc_id, edge.excerpt_id);
      addTo(this.excerptReferrers, edge.excerpt_id, edge.doc_id);
    }
    for (const [docId, ids] of byDoc) {
      this.docEdges.set(docId, ids);
      this.graph.setEdges(
        docId,
        [...ids].map((id) => this.excerptDoc.get(id)!).filter((d) => d !== docId),
      );
    }
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.init();
    return this.ready;
  }

  /**
   * Reboot path: drop all in-memory dependency state and rebuild it from the
   * persisted edges/excerpts. Rooms stay attached (their subscriptions point
   * at this singleton), so propagation resumes exactly where it left off.
   */
  async reboot(): Promise<void> {
    await this.ready;
    this.graph = new ReferenceGraph();
    this.docEdges = new Map();
    this.excerptReferrers = new Map();
    this.excerptDoc = new Map();
    this.excerptDocs = new Set();
    this.registrationEpoch = new Map();
    this.roleCache.clear();
    this.ready = this.init();
    await this.ready;
  }

  /**
   * Wire a freshly loaded room into the reference layer: re-sync on every
   * accepted edit, plus one initial reconcile (covers markers seeded or typed
   * while no sync has run yet). Idempotent per room.
   */
  attach(room: DocumentRoom): void {
    if (this.attached.has(room.docId)) return;
    this.attached.add(room.docId);
    room.subscribe((ev) => {
      if (ev.type === 'ops') void this.scheduleSync(room);
    });
    void this.scheduleSync(room);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Wait for dependency state to be rebuilt and (optionally) for a document's
   * queued anchor/edge sync to finish. Used by tests and after bootstrapping.
   */
  async settle(docId?: string): Promise<void> {
    await this.ensureReady();
    if (docId) {
      await this.flushDoc(docId);
    } else {
      await Promise.all([...this.syncs.values()]);
    }
  }

  private emit(ev: RefsEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  // ---- excerpt lifecycle hooks (called by excerptService) -----------------

  noteRegistered(row: ExcerptRow): void {
    this.excerptDoc.set(row.id, row.doc_id);
    this.excerptDocs.add(row.doc_id);
    this.registrationEpoch.set(row.doc_id, (this.registrationEpoch.get(row.doc_id) ?? 0) + 1);
  }

  noteUnregistered(row: ExcerptRow): void {
    // Keep excerptDoc: referrers still need the source doc to render the
    // degraded state. The row stays in Postgres (soft delete).
    const epoch = (this.registrationEpoch.get(row.doc_id) ?? 0) + 1;
    this.registrationEpoch.set(row.doc_id, epoch);
    void this.ensureReady().then(() => {
      void repo.listExcerpts(row.doc_id).then((remaining) => {
        // Prune only if nothing was registered/unregistered in the meantime.
        if (remaining.length === 0 && this.registrationEpoch.get(row.doc_id) === epoch) {
          this.excerptDocs.delete(row.doc_id);
        }
      });
      this.emitRefsChanged([row.id]);
    });
  }

  // ---- sync: anchors + edge reconciliation after edits --------------------

  /** Serialize syncs per document; returns the chained promise. */
  private scheduleSync(room: DocumentRoom): Promise<void> {
    const prev = this.syncs.get(room.docId) ?? Promise.resolve();
    const next = prev
      .then(() => this.syncRoom(room))
      .catch(() => undefined)
      .finally(() => {
        if (this.syncs.get(room.docId) === next) this.syncs.delete(room.docId);
      });
    this.syncs.set(room.docId, next);
    return next;
  }

  /** Wait for any pending sync of a doc (cycle checks need fresh edges). */
  private async flushDoc(docId: string): Promise<void> {
    await this.syncs.get(docId);
  }

  private async syncRoom(room: DocumentRoom): Promise<void> {
    await this.ensureReady();
    const docId = room.docId;
    const text = room.text();

    // 1. Re-anchor this document's excerpts against the new text.
    const changedExcerpts: string[] = [];
    if (this.excerptDocs.has(docId)) {
      const excerpts = await repo.listExcerpts(docId);
      for (const e of excerpts) {
        const r = resolveExcerptRow(e, room);
        const nextContent = r.status === 'anchored' ? r.content : e.last_content;
        const visibleChanged =
          r.status !== e.status || (r.status === 'anchored' && nextContent !== e.last_content);
        const anchorMoved =
          r.index !== e.anchor_idx ||
          !sameId(r.startId, e.start_id) ||
          !sameId(r.endId, e.end_id);
        if (visibleChanged || anchorMoved) {
          await repo.updateExcerptAnchor(e.id, r.index, r.status, nextContent, r.startId, r.endId);
          e.anchor_idx = r.index;
          e.status = r.status;
          e.last_content = nextContent;
          e.start_id = r.startId;
          e.end_id = r.endId;
          if (visibleChanged) changedExcerpts.push(e.id);
        }
      }
    }

    // 2. Reconcile outgoing edges with the markers present in the body.
    const markerIds = referencedExcerptIds(text);
    if (markerIds.length > 0 || this.docEdges.has(docId)) {
      const existing = await repo.listExcerptsByIds(markerIds);
      const known = new Set(existing.map((e) => e.id));
      for (const e of existing) this.excerptDoc.set(e.id, e.doc_id);
      const nextIds = markerIds.filter((id) => known.has(id));
      const prevIds = this.docEdges.get(docId) ?? new Set<string>();
      const changed =
        nextIds.length !== prevIds.size || nextIds.some((id) => !prevIds.has(id));
      if (changed) {
        await repo.reconcileEdges(docId, nextIds);
        const nextSet = new Set(nextIds);
        for (const id of prevIds) {
          if (!nextSet.has(id)) this.excerptReferrers.get(id)?.delete(docId);
        }
        for (const id of nextSet) addTo(this.excerptReferrers, id, docId);
        if (nextSet.size > 0) this.docEdges.set(docId, nextSet);
        else this.docEdges.delete(docId);
        this.graph.setEdges(
          docId,
          nextIds.map((id) => this.excerptDoc.get(id)!).filter((d) => d !== docId),
        );
        // The document's own rendered reference set changed.
        this.emit({ type: 'refs-changed', docIds: [docId] });
      }
    }

    // 3. Fan out excerpt content/status changes to affected referrers only.
    if (changedExcerpts.length > 0) this.emitRefsChanged(changedExcerpts);
  }

  /** Compute the affected document set for changed excerpts and emit. */
  private emitRefsChanged(excerptIds: string[]): void {
    const targets = new Set<string>();
    for (const id of excerptIds) {
      const src = this.excerptDoc.get(id);
      if (src) targets.add(src); // the source doc may reference its own excerpt
      for (const referrer of this.excerptReferrers.get(id) ?? []) {
        targets.add(referrer);
        for (const t of this.graph.allReferrers(referrer)) targets.add(t);
      }
    }
    if (targets.size > 0) this.emit({ type: 'refs-changed', docIds: [...targets] });
  }

  // ---- cycle detection -----------------------------------------------------

  /**
   * Would a reference from `docId` to `excerptId` close a dependency loop?
   * Same-document references are always allowed (they cannot recurse across
   * documents; the renderer's trail guard covers pathological self-nesting).
   */
  async wouldCycle(docId: string, excerptId: string): Promise<boolean> {
    await this.ensureReady();
    const excerpt = await repo.getExcerpt(excerptId);
    if (!excerpt) return false;
    if (excerpt.doc_id === docId) return false;
    // Both endpoints' edges must reflect their latest bodies before judging.
    await Promise.all([this.flushDoc(docId), this.flushDoc(excerpt.doc_id)]);
    return this.graph.wouldCycle(docId, excerpt.doc_id);
  }

  // ---- per-viewer snapshots -------------------------------------------------

  /**
   * Resolve every excerpt reachable from `docId`'s references (transitively),
   * with `userId`'s permissions applied. Forbidden excerpts carry metadata but
   * never content.
   */
  async snapshotFor(docId: string, userId: string): Promise<RefState[]> {
    await this.ensureReady();
    await this.flushDoc(docId);

    // BFS over doc -> excerpt -> source doc -> its excerpts ...
    const needed = new Map<string, string>(); // excerptId -> sourceDocId
    const queue = [docId];
    const seenDocs = new Set<string>([docId]);
    while (queue.length > 0) {
      const d = queue.shift()!;
      for (const excerptId of this.docEdges.get(d) ?? []) {
        if (needed.has(excerptId)) continue;
        const src = this.excerptDoc.get(excerptId);
        if (!src) continue;
        needed.set(excerptId, src);
        if (!seenDocs.has(src)) {
          seenDocs.add(src);
          queue.push(src);
        }
      }
    }
    if (needed.size === 0) return [];

    const rows = new Map(
      (await repo.listExcerptsByIds([...needed.keys()])).map((e) => [e.id, e]),
    );
    const titles = new Map<string, string>();
    await Promise.all(
      [...new Set(needed.values())].map(async (d) => {
        const doc = await repo.getDoc(d);
        titles.set(d, doc?.title ?? '未知文档');
      }),
    );

    const out: RefState[] = [];
    for (const [excerptId, src] of needed) {
      const row = rows.get(excerptId);
      const allowed = await this.canView(userId, src);
      const live = !!row && !row.deleted && row.status === 'anchored';
      out.push({
        excerptId,
        sourceDocId: src,
        sourceTitle: titles.get(src) ?? '未知文档',
        status: live ? 'anchored' : 'invalid',
        content: allowed && row ? row.last_content : '',
        allowed,
      });
    }
    return out;
  }

  private async canView(userId: string, docId: string): Promise<boolean> {
    const key = `${userId}:${docId}`;
    const hit = this.roleCache.get(key);
    if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.ok;
    const role = await repo.getRole(docId, userId);
    const ok = role !== null;
    this.roleCache.set(key, { ok, at: Date.now() });
    return ok;
  }
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

export const referenceCoordinator = new ReferenceCoordinator();
