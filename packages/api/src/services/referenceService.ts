/**
 * Cross-document live-reference service.
 *
 * Owns the three reference-specific concerns that have nothing to do with the
 * single-document CRDT merge:
 *
 *  1. snippet registration and anchor following (`register`, `reanchor`);
 *  2. the "who references whom" dependency edges, including cycle rejection at
 *     creation time (`createReference`);
 *  3. permission-aware content views: a reference's real content is only ever
 *     handed to users who may view the *source* document (`viewFor`).
 */

import { resolveSnippet, wouldCreateCycle } from '@collabmd/core';
import { repo, type SnippetRow } from '../repo.js';
import { getRoom } from '../realtime/DocumentRoom.js';
import type { Role } from '../config.js';

const newId = (p: string): string =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export type RefViewState = 'anchored' | 'lost' | 'denied' | 'invalid';

export interface RefView {
  snippetId: string;
  sourceDocId: string;
  sourceTitle: string;
  status: RefViewState;
  /** Last-known source content (present even when lost; absent when denied). */
  content: string | null;
  index: number;
}

export interface SnippetSummary {
  id: string;
  doc_id: string;
  quote: string;
  anchor_idx: number;
  status: 'anchored' | 'lost';
  author: string;
  title: string;
  created_at: number;
}

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

function viewForSnippetRow(s: SnippetRow, sourceTitle: string): RefView {
  return {
    snippetId: s.id,
    sourceDocId: s.doc_id,
    sourceTitle,
    status: s.status,
    content: s.quote,
    index: s.anchor_idx,
  };
}

export const referenceService = {
  /**
   * Register the current selection of `docId` as a citable snippet. Only view
   * access on the source document is required — annotating source content
   * doesn't edit its body.
   */
  async register(
    docId: string,
    author: string,
    quote: string,
    index: number,
    title: string,
  ): Promise<SnippetSummary> {
    const room = await getRoom(docId);
    const text = room.text();
    const safeIndex = Math.max(
      0,
      Math.min(index, Math.max(0, text.length - quote.length)),
    );
    // Normalise to whatever the source text actually holds at that range.
    const resolved = resolveSnippet(
      { quote: text.substr(safeIndex, quote.length) || quote, index: safeIndex, status: 'anchored' },
      text,
    );
    const row: SnippetRow = {
      id: newId('sfr'),
      doc_id: docId,
      quote: resolved.content,
      anchor_idx: resolved.index,
      status: 'anchored',
      author,
      title: title.trim() || quote.slice(0, 24),
      created_at: Date.now(),
    };
    await repo.insertSnippet(row);
    return row;
  },

  async listForDoc(docId: string): Promise<SnippetSummary[]> {
    return repo.listSnippets(docId);
  },

  /**
   * Create a reference edge from `refDocId` to the snippet's source document.
   * Throws CycleError when the edge would close a direct/indirect cycle, and
   * returns null when the snippet does not exist.
   */
  async createReference(snippetId: string, refDocId: string): Promise<boolean | null> {
    const snippet = await repo.getSnippet(snippetId);
    if (!snippet) return null;
    const sourceDocId = snippet.doc_id;

    // Collapse per-snippet edges to document-level edges before cycle testing.
    const rows = await repo.listAllRefEdges();
    const owners = await repo.getSnippets([...new Set(rows.map((e) => e.snippet_id))]);
    const ownerOf = new Map(owners.map((s) => [s.id, s.doc_id]));
    const dep = rows
      .map((e) => ({ refDocId: e.ref_doc_id, sourceDocId: ownerOf.get(e.snippet_id) }))
      .filter((e): e is { refDocId: string; sourceDocId: string } => !!e.sourceDocId);

    if (wouldCreateCycle(dep, refDocId, sourceDocId)) {
      throw new CycleError(
        '该引用会形成循环依赖（文档间引用必须是有向无环图），已拒绝建立',
      );
    }

    return repo.insertRefEdge(snippetId, refDocId);
  },

  /**
   * Re-resolve every snippet of a source document against its latest text,
   * persist adopted quotes/positions, and return only the snippets whose
   * rendered content or status actually changed (so propagation stays precise).
   */
  async reanchor(docId: string, text: string): Promise<SnippetRow[]> {
    const rows = await repo.listSnippets(docId);
    const changed: SnippetRow[] = [];
    for (const s of rows) {
      const r = resolveSnippet(
        { quote: s.quote, index: s.anchor_idx, status: s.status },
        text,
      );
      if (r.quote !== s.quote || r.index !== s.anchor_idx || r.status !== s.status) {
        await repo.updateSnippetAnchor(s.id, r.quote, r.index, r.status);
        s.quote = r.quote;
        s.anchor_idx = r.index;
        s.status = r.status;
        changed.push(s);
      }
    }
    return changed;
  },

  /**
   * Permission-aware view of one snippet for one user. Caller passes the role
   * the user holds on the *source* document (null = no access). The stored
   * quote is never returned without source-view permission.
   */
  async viewFor(
    snippetId: string,
    sourceRole: Role | null,
  ): Promise<RefView | null> {
    const snippet = await repo.getSnippet(snippetId);
    if (!snippet) {
      return {
        snippetId,
        sourceDocId: '',
        sourceTitle: '',
        status: 'invalid',
        content: null,
        index: 0,
      };
    }
    const doc = await repo.getDoc(snippet.doc_id);
    const sourceTitle = doc?.title ?? '未知文档';
    if (!sourceRole) {
      return {
        snippetId,
        sourceDocId: snippet.doc_id,
        sourceTitle,
        status: 'denied',
        content: null,
        index: 0,
      };
    }
    return viewForSnippetRow(snippet, sourceTitle);
  },

  /** Batch permission-aware views; `roles` maps source doc id -> user's role. */
  async viewForMany(
    snippetIds: string[],
    roleOfSourceDoc: (sourceDocId: string) => Promise<Role | null>,
  ): Promise<RefView[]> {
    const snippets = await repo.getSnippets([...new Set(snippetIds)]);
    const docIds = [...new Set(snippets.map((s) => s.doc_id))];
    const titles = new Map<string, string>();
    const roles = new Map<string, Role | null>();
    for (const docId of docIds) {
      const [doc, role] = await Promise.all([
        repo.getDoc(docId),
        roleOfSourceDoc(docId),
      ]);
      titles.set(docId, doc?.title ?? '未知文档');
      roles.set(docId, role);
    }
    return snippetIds.map((id) => {
      const s = snippets.find((x) => x.id === id);
      if (!s) {
        return { snippetId: id, sourceDocId: '', sourceTitle: '', status: 'invalid' as const, content: null, index: 0 };
      }
      if (!roles.get(s.doc_id)) {
        return {
          snippetId: id,
          sourceDocId: s.doc_id,
          sourceTitle: titles.get(s.doc_id)!,
          status: 'denied' as const,
          content: null,
          index: 0,
        };
      }
      return viewForSnippetRow(s, titles.get(s.doc_id)!);
    });
  },
};
