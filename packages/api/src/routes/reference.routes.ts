/**
 * HTTP routes for cross-document live references.
 *
 * Two distinct operations, two distinct permission checks:
 *  - registering a citable *snippet* annotates a source document (comment-level
 *    access is enough); it never changes the source body;
 *  - inserting a reference *block* edits the current document's body (requires
 *    body-edit there) AND requires view access to the snippet's source doc.
 */

import type { FastifyInstance } from 'fastify';
import {
  buildMarkerInsertion,
  findMarkers,
  markerLine,
} from '@collabmd/core';
import { repo } from '../repo.js';
import { newId, requireRole, requireUser, roleCan } from '../auth.js';
import { getRoom } from '../realtime/DocumentRoom.js';
import { referenceService, CycleError } from '../services/referenceService.js';

export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  // ---- snippets registered in a source document ----

  app.get('/api/documents/:id/snippets', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await repo.getRole(id, user.id))) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const snippets = await referenceService.listForDoc(id);
    return { snippets };
  });

  app.post('/api/documents/:id/snippets', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    // Registration is an annotation: reviewers (comment permission) and up.
    await requireRole(id, user, roleCan.comment);
    const { quote, index, title } = req.body as {
      quote?: string;
      index?: number;
      title?: string;
    };
    if (!quote || typeof index !== 'number' || quote.length === 0) {
      return reply.code(400).send({ error: '需要选中正文片段 (quote, index)' });
    }
    const snippet = await referenceService.register(
      id,
      user.id,
      quote,
      index,
      title?.trim() ?? '',
    );
    return { snippet };
  });

  /** Picker catalogue: every snippet in documents the caller may view. */
  app.get('/api/snippets/catalog', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const accessible = await repo.listDocsAccessible(user.id);
    const titleOf = new Map(accessible.map((d) => [d.id, d.title]));
    const catalog: Array<{
      id: string;
      docId: string;
      docTitle: string;
      title: string;
      quote: string;
      status: 'anchored' | 'lost';
    }> = [];
    for (const doc of accessible) {
      const snippets = await referenceService.listForDoc(doc.id);
      for (const s of snippets) {
        catalog.push({
          id: s.id,
          docId: s.doc_id,
          docTitle: titleOf.get(s.doc_id) ?? '未知文档',
          title: s.title,
          quote: s.quote,
          status: s.status,
        });
      }
    }
    return { snippets: catalog };
  });

  // ---- reference blocks in a referencing document ----

  /** Initial hydration: permission-filtered content for the doc's markers. */
  app.get('/api/documents/:id/references', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await repo.getRole(id, user.id))) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const room = await getRoom(id);
    const snippetIds = findMarkers(room.text()).map((m) => m.snippetId);
    const refs = await referenceService.viewForMany(snippetIds, async (sourceDocId) =>
      repo.getRole(sourceDocId, user.id),
    );
    return { refs };
  });

  /**
   * Insert a reference block. Body: { snippetId, index }. Performs all three
   * server-side gates in order: body-edit on this doc, view on the source doc,
   * cycle rejection. The marker is then authored into the CRDT server-side (so
   * it converges like any rollback edit) and the dependency edge is persisted.
   */
  app.post('/api/documents/:id/references', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await requireRole(id, user, roleCan.editBody);

    const { snippetId, index } = req.body as { snippetId?: string; index?: number };
    if (!snippetId || typeof index !== 'number') {
      return reply.code(400).send({ error: '需要 snippetId 与插入位置 index' });
    }

    const snippet = await repo.getSnippet(snippetId);
    if (!snippet) return reply.code(404).send({ error: '引用片段不存在' });

    // Source view permission: a user must not embed content they can't read.
    const sourceRole = await repo.getRole(snippet.doc_id, user.id);
    if (!sourceRole) {
      return reply.code(403).send({ error: '无权查看该引用来源，不能引用' });
    }

    // Cycle rejection (direct + indirect).
    try {
      const created = await referenceService.createReference(snippetId, id);
      if (created === null) return reply.code(404).send({ error: '引用片段不存在' });
    } catch (e) {
      if (e instanceof CycleError) {
        return reply.code(409).send({ error: e.message, code: 'ref_cycle' });
      }
      throw e;
    }

    // Author the compact marker into the body through the authoritative room.
    const room = await getRoom(id);
    const blockId = newId('ref');
    const edit = buildMarkerInsertion(room.text(), index, snippetId, blockId);
    const ops = room.doc.edit(user.id, edit.index, edit.delCount, edit.inserted);
    await room.appendSystemOps(ops, user.id);

    const ref = await referenceService.viewFor(snippetId, sourceRole);
    return { blockId, marker: markerLine(snippetId, blockId), ref };
  });
}
