/**
 * Cross-document change propagation.
 *
 * The single-document authority (`DocumentRoom`) only knows about edits to its
 * own CRDT. This layer sits *above* those rooms and bridges the document
 * boundary:
 *
 *   source room emits 'ops'
 *     -> re-resolve that source document's registered snippets (anchor follow)
 *     -> look up which referencing documents depend on the changed snippets
 *     -> notify only the rooms actually open right now, with only the affected
 *        snippet ids (no global broadcast, no polling)
 *
 * Content itself never travels here; rooms receive a "these snippets changed"
 * nudge and the gateway resolves the content per viewer after a source
 * permission check, so the realtime channel carries no data a user can't see.
 */

import type { DocumentRoom } from './DocumentRoom.js';
import { peekRoom } from './DocumentRoom.js';
import { repo } from '../repo.js';
import { referenceService } from '../services/referenceService.js';

type StopFn = () => void;

class ReferencePropagator {
  private watched = new Set<string>();
  private stops = new Map<string, StopFn>();

  /**
   * Start watching a room. Idempotent; safe to call for every opened socket.
   * The reference concern subscribes but never alters room contents.
   */
  watch(room: DocumentRoom): void {
    if (this.watched.has(room.docId)) return;
    this.watched.add(room.docId);

    const off = room.subscribe(async (ev) => {
      if (ev.type !== 'ops') return;
      await this.onSourceChanged(room);
    });
    this.stops.set(room.docId, off);
  }

  /**
   * Re-anchor the source document's snippets after an edit, persist adopted
   * positions/quotes, and fan a precise nudge out to referencing rooms.
   */
  private async onSourceChanged(room: DocumentRoom): Promise<void> {
    let changed;
    try {
      changed = await referenceService.reanchor(room.docId, room.text());
    } catch (e) {
      console.error('[refs] reanchor failed', room.docId, e);
      return;
    }
    if (changed.length === 0) return;

    const changedIds = changed.map((s) => s.id);

    // Which documents reference any of the changed snippets?
    const affected = new Set<string>();
    for (const id of changedIds) {
      const edges = await repo.listEdgesBySnippet(id);
      for (const e of edges) affected.add(e.ref_doc_id);
    }

    for (const refDocId of affected) {
      if (refDocId === room.docId) continue; // self edges are rejected anyway
      const target = peekRoom(refDocId);
      if (!target) continue; // nobody has it open; it will re-hydrate on connect
      target.notifySnippetsChanged(changedIds);
    }
  }
}

export const referencePropagator = new ReferencePropagator();
