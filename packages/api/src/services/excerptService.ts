import { repo, type ExcerptRow } from '../repo.js';
import { getRoom } from '../realtime/DocumentRoom.js';
import { referenceCoordinator, resolveExcerptRow } from '../realtime/ReferenceCoordinator.js';

const newId = (p: string): string =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export interface ExcerptView {
  id: string;
  doc_id: string;
  quote: string;
  index: number;
  end: number;
  status: 'anchored' | 'invalid';
  /** Current passage while anchored; last seen content once invalidated. */
  content: string;
  author: string;
  created_at: number;
}

function toView(e: ExcerptRow, index: number, end: number, content: string, status: 'anchored' | 'invalid'): ExcerptView {
  return {
    id: e.id,
    doc_id: e.doc_id,
    quote: e.quote,
    index,
    end,
    status,
    content,
    author: e.author,
    created_at: e.created_at,
  };
}

/** Live resolution of a stored excerpt row against its source room. */
export function resolveRow(e: ExcerptRow, room: Parameters<typeof resolveExcerptRow>[1]): ExcerptView {
  const r = resolveExcerptRow(e, room);
  if (r.status === 'anchored') {
    return toView(e, r.index, r.end, r.content, 'anchored');
  }
  // Anchor lost: keep the last seen content rather than the original quote.
  return toView(e, r.index, r.end, e.last_content, 'invalid');
}

/**
 * Excerpt lifecycle: registering a passage as referenceable, listing a
 * document's excerpts (for the picker) and unregistering. Anchor *following*
 * on edits and cross-document propagation live in the ReferenceCoordinator.
 */
export const excerptService = {
  async listForDoc(docId: string): Promise<ExcerptView[]> {
    const rows = await repo.listExcerpts(docId);
    if (rows.length === 0) return [];
    const room = await getRoom(docId);
    return rows.map((e) => resolveRow(e, room));
  },

  async register(docId: string, author: string, quote: string, index: number): Promise<ExcerptRow> {
    const room = await getRoom(docId);
    const text = room.text();
    if (quote.length === 0 || text.slice(index, index + quote.length) !== quote) {
      throw Object.assign(new Error('选中内容与当前正文不一致，请重新选择'), { status: 400 });
    }
    // Anchor on the CRDT character ids at the passage boundaries: they track
    // the passage exactly through shifts and interior rewrites.
    const ids = room.doc.visibleIds();
    const row: ExcerptRow = {
      id: newId('ex'),
      doc_id: docId,
      quote,
      anchor_idx: index,
      start_id: ids[index] ?? null,
      end_id: ids[index + quote.length - 1] ?? null,
      status: 'anchored',
      last_content: quote,
      deleted: false,
      author,
      created_at: Date.now(),
    };
    await repo.insertExcerpt(row);
    referenceCoordinator.noteRegistered(row);
    return row;
  },

  /** Soft delete: referrers degrade to the invalid state, nothing vanishes. */
  async unregister(excerptId: string): Promise<ExcerptRow | null> {
    const row = await repo.getExcerpt(excerptId);
    if (!row || row.deleted) return null;
    await repo.softDeleteExcerpt(excerptId);
    referenceCoordinator.noteUnregistered(row);
    return row;
  },
};
