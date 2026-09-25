import type { FastifyInstance } from 'fastify';
import { refMarker } from '@collabmd/core';
import { repo } from '../repo.js';
import { requireRole, requireUser, roleCan } from '../auth.js';
import { excerptService } from '../services/excerptService.js';
import { referenceCoordinator } from '../realtime/ReferenceCoordinator.js';
import { getRoom } from '../realtime/DocumentRoom.js';

/**
 * REST surface for live cross-document references. Realtime propagation rides
 * the websocket channel; these endpoints cover registration, the picker,
 * insertion (a server-side body edit appending the compact marker) and the
 * per-viewer snapshot used for hydration and tests.
 */
export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  // Register a selected passage of this document as a referenceable excerpt.
  app.post('/api/documents/:id/excerpts', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await requireRole(id, user, roleCan.editBody);
    const { quote, index } = req.body as { quote?: string; index?: number };
    if (!quote || typeof index !== 'number' || index < 0) {
      return reply.code(400).send({ error: '需要选中的正文片段 (quote, index)' });
    }
    const excerpt = await excerptService.register(id, user.id, quote, index);
    return { excerpt };
  });

  // Excerpts defined in a document (for the insert-reference picker).
  app.get('/api/documents/:id/excerpts', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await repo.getRole(id, user.id))) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const excerpts = await excerptService.listForDoc(id);
    return { excerpts };
  });

  // Unregister an excerpt. Referrers degrade to "引用已失效" with the last
  // seen content kept; nothing disappears.
  app.delete('/api/excerpts/:excerptId', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { excerptId } = req.params as { excerptId: string };
    const row = await repo.getExcerpt(excerptId);
    if (!row) return reply.code(404).send({ error: '片段不存在' });
    await requireRole(row.doc_id, user, roleCan.editBody);
    await excerptService.unregister(excerptId);
    return { ok: true };
  });

  /**
   * Insert a reference block into the current document. Permission: the
   * caller's ordinary body-edit right on *this* document, plus read access to
   * the excerpt's source document. Dependency cycles are refused here.
   */
  app.post('/api/documents/:id/references', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    await requireRole(id, user, roleCan.editBody);
    const { excerptId, index } = req.body as { excerptId?: string; index?: number };
    if (!excerptId) return reply.code(400).send({ error: '缺少 excerptId' });

    const excerpt = await repo.getExcerpt(excerptId);
    if (!excerpt || excerpt.deleted) {
      return reply.code(404).send({ error: '被引用的片段不存在或已取消登记' });
    }
    if (!(await repo.getRole(excerpt.doc_id, user.id))) {
      return reply.code(403).send({ error: '无权查看该引用来源文档' });
    }
    if (await referenceCoordinator.wouldCycle(id, excerptId)) {
      return reply
        .code(409)
        .send({ error: '无法建立引用：这会造成文档间的循环引用' });
    }

    // Append the compact marker as a server-side CRDT edit so it merges,
    // persists and broadcasts exactly like any collaborator's edit. The marker
    // is placed at the caller's cursor (document end by default) on its own
    // line.
    const room = await getRoom(id);
    const text = room.text();
    const at = Math.max(0, Math.min(typeof index === 'number' ? index : text.length, text.length));
    let insert = refMarker(excerptId);
    if (at > 0 && text[at - 1] !== '\n') insert = `\n${insert}`;
    if (at >= text.length) insert = `${insert}\n`;
    else if (text[at] !== '\n') insert = `${insert}\n`;
    const ops = room.doc.edit(`ref:${user.id}`, at, 0, insert);
    await room.appendSystemOps(ops, user.id);
    return { ok: true, excerptId };
  });

  // Per-viewer reference snapshot for a document (hydration / REST fallback).
  app.get('/api/documents/:id/references', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await repo.getRole(id, user.id))) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const refs = await referenceCoordinator.snapshotFor(id, user.id);
    return { refs };
  });
}
