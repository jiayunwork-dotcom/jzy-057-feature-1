import { describe, expect, it, beforeAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';

// ---- in-memory persistence ---------------------------------------------
interface U { id: string; username: string; pass_hash: string; color: string }
interface Doc { id: string; folder_id: string | null; title: string; owner_id: string }

const db = {
  users: new Map<string, U>(),
  tokens: new Map<string, string>(),
  docs: new Map<string, Doc>(),
  members: new Map<string, string>(), // `${docId}:${userId}` -> role
  ops: new Map<string, any[]>(),
  versions: new Map<string, any[]>(),
  comments: new Map<string, any[]>(),
  replies: new Map<string, any[]>(),
  excerpts: new Map<string, any>(),
  edges: new Set<string>(), // `${docId}::${excerptId}`
};

const membersKey = (d: string, u: string) => `${d}:${u}`;

vi.mock('../src/db.js', () => ({ pool: {} }));
vi.mock('../src/redis.js', () => ({ connectRedis: vi.fn(), redis: vi.fn() }));

vi.mock('../src/repo.js', () => {
  const roleOf = (docId: string, userId: string) => {
    const doc = db.docs.get(docId);
    if (!doc) return null;
    if (doc.owner_id === userId) return 'owner';
    return db.members.get(membersKey(docId, userId)) ?? null;
  };
  return {
    repo: {
      findUserByLogin: async (username: string) =>
        [...db.users.values()].find((u) => u.username === username) ?? null,
      createUser: async (u: U) => void db.users.set(u.id, { ...u }),
      issueToken: async (t: string, uid: string) => void db.tokens.set(t, uid),
      revokeToken: async (t: string) => void db.tokens.delete(t),
      userForToken: async (t: string) => {
        const uid = db.tokens.get(t);
        return uid ? db.users.get(uid) ?? null : null;
      },
      listUsers: async () =>
        [...db.users.values()].map(({ id, username, color }) => ({ id, username, color })),

      listFolders: async () => [],
      listDocsAccessible: async (userId: string) =>
        [...db.docs.values()]
          .map((d) => ({ ...d, role: roleOf(d.id, userId) }))
          .filter((d) => d.role),
      getDoc: async (id: string) => db.docs.get(id) ?? null,
      createDoc: async (d: Doc) => void db.docs.set(d.id, { ...d }),
      touchDoc: vi.fn(),

      getRole: roleOf,
      setRole: async (d: string, u: string, r: string) =>
        void db.members.set(membersKey(d, u), r),
      listMembers: async () => [],

      loadOps: async (d: string) => db.ops.get(d) ?? [],
      appendOps: async (d: string, start: number, ops: any[]) => {
        const arr = db.ops.get(d) ?? [];
        arr.splice(start, ops.length, ...ops);
        db.ops.set(d, arr);
      },

      listVersions: async (d: string) => db.versions.get(d) ?? [],
      insertVersion: async (v: any) => {
        const arr = db.versions.get(v.doc_id) ?? [];
        arr.push(v);
        db.versions.set(v.doc_id, arr);
      },

      listComments: async (d: string) => db.comments.get(d) ?? [],
      insertComment: async (c: any) => {
        const arr = db.comments.get(c.doc_id) ?? [];
        arr.push(c);
        db.comments.set(c.doc_id, arr);
      },
      updateCommentAnchor: vi.fn(),
      setCommentState: vi.fn(),
      listReplies: async () => [],
      insertReply: async (r: any) => {
        const arr = db.replies.get(r.comment_id) ?? [];
        arr.push(r);
        db.replies.set(r.comment_id, arr);
      },

      insertExcerpt: async (e: any) => void db.excerpts.set(e.id, { ...e }),
      getExcerpt: async (id: string) => db.excerpts.get(id) ?? null,
      listExcerpts: async (docId: string) =>
        [...db.excerpts.values()].filter((e) => e.doc_id === docId && !e.deleted),
      listExcerptsByIds: async (ids: string[]) =>
        ids.map((id) => db.excerpts.get(id)).filter(Boolean),
      listAllExcerpts: async () => [...db.excerpts.values()],
      updateExcerptAnchor: async (
        id: string,
        idx: number,
        status: string,
        last: string,
        startId: any,
        endId: any,
      ) => {
        const e = db.excerpts.get(id);
        if (e) {
          e.anchor_idx = idx;
          e.status = status;
          e.last_content = last;
          e.start_id = startId;
          e.end_id = endId;
        }
      },
      softDeleteExcerpt: async (id: string) => {
        const e = db.excerpts.get(id);
        if (e) e.deleted = true;
      },
      reconcileEdges: async (docId: string, excerptIds: string[]) => {
        for (const key of [...db.edges]) {
          const [d, e] = key.split('::');
          if (d === docId && !excerptIds.includes(e)) db.edges.delete(key);
        }
        for (const e of excerptIds) db.edges.add(`${docId}::${e}`);
      },
      listEdgesForDoc: async (docId: string) =>
        [...db.edges]
          .filter((k) => k.startsWith(`${docId}::`))
          .map((k) => ({ doc_id: docId, excerpt_id: k.split('::')[1] })),
      listEdgesReferencing: async (excerptIds: string[]) =>
        [...db.edges]
          .map((k) => k.split('::'))
          .filter(([, e]) => excerptIds.includes(e))
          .map(([d, e]) => ({ doc_id: d, excerpt_id: e })),
      listAllEdges: async () =>
        [...db.edges].map((k) => {
          const [d, e] = k.split('::');
          return { doc_id: d, excerpt_id: e };
        }),
      listReferencedExcerpts: async (docId: string) =>
        [...db.edges]
          .filter((k) => k.startsWith(`${docId}::`))
          .map((k) => db.excerpts.get(k.split('::')[1]))
          .filter(Boolean),
    },
  };
});

import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { getRoom } from '../src/realtime/DocumentRoom.js';
import { referenceCoordinator } from '../src/realtime/ReferenceCoordinator.js';
import { CrdtDoc, refMarker } from '@collabmd/core';

let app: FastifyInstance;

const OWNER = 'u-owner';
const EDITOR = 'u-editor';
const REVIEWER = 'u-reviewer';
const VIEWER = 'u-viewer';

async function tokenFor(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

async function asUser(token: string) {
  const headers = { cookie: `cmdtoken=${token}` };
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url, headers, payload }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers }),
  };
}

let counter = 0;
/** Fresh document owned by owner, with editor/reviewer/viewer memberships. */
async function makeDoc(title: string, text: string, suffix?: string): Promise<string> {
  const id = `doc-${counter++}${suffix ?? ''}`;
  db.docs.set(id, { id, folder_id: null, title, owner_id: OWNER });
  db.members.set(membersKey(id, EDITOR), 'editor');
  db.members.set(membersKey(id, REVIEWER), 'reviewer');
  db.members.set(membersKey(id, VIEWER), 'viewer');
  if (text.length > 0) {
    const room = await getRoom(id);
    const seed = new CrdtDoc();
    await room.ingest(seed.edit('seed', 0, 0, text), 'seed');
  }
  return id;
}

/** Apply a plain-text replacement to a doc through its authoritative room. */
async function editDoc(docId: string, index: number, delCount: number, inserted: string): Promise<void> {
  const room = await getRoom(docId);
  const local = new CrdtDoc();
  room.allOps().forEach((o) => local.integrate(o));
  const ops = local.edit('tester', index, delCount, inserted);
  await room.ingest(ops, 'tester');
  await referenceCoordinator.settle(docId);
}

async function refsFor(token: string, docId: string): Promise<any[]> {
  const user = await asUser(token);
  const res = await user.get(`/api/documents/${docId}/references`);
  expect(res.statusCode).toBe(200);
  return (res.json() as { refs: any[] }).refs;
}

beforeAll(async () => {
  app = await buildApp();
  const mk = (id: string, username: string, color: string, pw: string): U => ({
    id, username, color, pass_hash: bcrypt.hashSync(pw, 10),
  });
  for (const u of [
    mk(OWNER, 'owner', '#4363d8', 'owner123'),
    mk(EDITOR, 'editor', '#3cb44b', 'editor123'),
    mk(REVIEWER, 'reviewer', '#f58231', 'reviewer123'),
    mk(VIEWER, 'viewer', '#911eb4', 'viewer123'),
  ]) {
    db.users.set(u.id, u);
  }
});

describe('live cross-document references', () => {
  it('propagates source edits to every referrer verbatim', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);
    const viewerTok = await tokenFor('viewer', 'viewer123');

    const src = await makeDoc('源文档', '头部\n共享的前置条件段落。\n尾部');
    const refA = await makeDoc('引用方甲', '# 甲\n');
    const refB = await makeDoc('引用方乙', '# 乙\n');

    const quote = '共享的前置条件段落。';
    const reg = await owner.post(`/api/documents/${src}/excerpts`, { quote, index: 3 });
    expect(reg.statusCode).toBe(200);
    const excerptId = (reg.json() as any).excerpt.id;

    // Two documents reference the same excerpt; events must name exactly the
    // affected documents (targeted, not broadcast).
    const events: string[][] = [];
    const off = referenceCoordinator.subscribe((ev) => events.push(ev.docIds));

    expect((await owner.post(`/api/documents/${refA}/references`, { excerptId })).statusCode).toBe(200);
    expect((await owner.post(`/api/documents/${refB}/references`, { excerptId })).statusCode).toBe(200);
    await referenceCoordinator.settle();

    // Edit the source passage itself.
    const room = await getRoom(src);
    const idx = room.text().indexOf('前置条件');
    await editDoc(src, idx, 4, '上线前置检查');

    const want = '共享的上线前置检查段落。';
    for (const docId of [refA, refB]) {
      const refs = await refsFor(ownerTok, docId);
      const r = refs.find((x) => x.excerptId === excerptId);
      expect(r.status).toBe('anchored');
      expect(r.content).toBe(want);
      expect(r.sourceTitle).toBe('源文档');
    }
    // A viewer of the referrer (with source access) sees the same content.
    const viewerRefs = await refsFor(viewerTok, refA);
    expect(viewerRefs.find((x) => x.excerptId === excerptId).content).toBe(want);

    // The change events covered exactly {source, refA, refB} — no one else.
    const fanned = events.filter((ds) => ds.includes(src));
    expect(fanned.length).toBeGreaterThan(0);
    for (const ds of fanned) {
      expect([...ds].sort()).toEqual([refA, refB, src].sort());
    }
    off();
  });

  it('keeps the anchor on the original passage when text is inserted before it', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const src = await makeDoc('源', '前置条件：Node 20 与 Postgres 16。\n其他内容');
    const refDoc = await makeDoc('引用方', '# 正文\n');
    const quote = '前置条件：Node 20 与 Postgres 16。';
    const reg = await owner.post(`/api/documents/${src}/excerpts`, { quote, index: 0 });
    const excerptId = (reg.json() as any).excerpt.id;
    await owner.post(`/api/documents/${refDoc}/references`, { excerptId });
    await referenceCoordinator.settle();

    // Insert a large block in front of the passage.
    await editDoc(src, 0, 0, '新增的前言章节。\n'.repeat(40));

    const refs = await refsFor(ownerTok, refDoc);
    const r = refs.find((x) => x.excerptId === excerptId);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe(quote); // still the original passage, no drift
  });

  it('degrades to invalid with last content kept when the passage is deleted', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const src = await makeDoc('源', '保留这段。\n将被整段删除的引用内容。\n结尾。');
    const refDoc = await makeDoc('引用方', '# 正文\n');
    const quote = '将被整段删除的引用内容。';
    const reg = await owner.post(`/api/documents/${src}/excerpts`, {
      quote,
      index: '保留这段。\n'.length,
    });
    const excerptId = (reg.json() as any).excerpt.id;
    await owner.post(`/api/documents/${refDoc}/references`, { excerptId });
    await referenceCoordinator.settle();

    // Delete the whole passage from the source document.
    const room = await getRoom(src);
    const at = room.text().indexOf(quote);
    await editDoc(src, at, quote.length, '');

    let refs = await refsFor(ownerTok, refDoc);
    let r = refs.find((x) => x.excerptId === excerptId);
    expect(r.status).toBe('invalid');
    expect(r.content).toBe(quote); // last seen content retained
    expect(r.sourceTitle).toBe('源');

    // Unregistering the excerpt keeps the same degraded contract.
    const src2 = await makeDoc('源2', '另一段可引用内容。');
    const ref2 = await makeDoc('引用方2', '# 正文\n');
    const reg2 = await owner.post(`/api/documents/${src2}/excerpts`, {
      quote: '另一段可引用内容。',
      index: 0,
    });
    const excerpt2 = (reg2.json() as any).excerpt.id;
    await owner.post(`/api/documents/${ref2}/references`, { excerptId: excerpt2 });
    await referenceCoordinator.settle();
    expect((await owner.delete(`/api/excerpts/${excerpt2}`)).statusCode).toBe(200);
    await referenceCoordinator.settle();

    refs = await refsFor(ownerTok, ref2);
    r = refs.find((x) => x.excerptId === excerpt2);
    expect(r.status).toBe('invalid');
    expect(r.content).toBe('另一段可引用内容。');
  });

  it('refuses direct and indirect reference cycles with a clear error', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const docA = await makeDoc('甲', '甲的片段一。\n');
    const docB = await makeDoc('乙', '乙的片段二。\n');
    const docC = await makeDoc('丙', '丙的片段三。\n');

    const exA = ((await owner.post(`/api/documents/${docA}/excerpts`, { quote: '甲的片段一。', index: 0 })).json() as any).excerpt.id;
    const exB = ((await owner.post(`/api/documents/${docB}/excerpts`, { quote: '乙的片段二。', index: 0 })).json() as any).excerpt.id;
    const exC = ((await owner.post(`/api/documents/${docC}/excerpts`, { quote: '丙的片段三。', index: 0 })).json() as any).excerpt.id;

    // A -> B, B -> C are fine.
    expect((await owner.post(`/api/documents/${docA}/references`, { excerptId: exB })).statusCode).toBe(200);
    expect((await owner.post(`/api/documents/${docB}/references`, { excerptId: exC })).statusCode).toBe(200);
    await referenceCoordinator.settle();

    // C -> A would close an indirect loop: refused.
    const indirect = await owner.post(`/api/documents/${docC}/references`, { excerptId: exA });
    expect(indirect.statusCode).toBe(409);
    expect((indirect.json() as any).error).toContain('循环引用');

    // B -> A would close a direct loop: refused.
    const direct = await owner.post(`/api/documents/${docB}/references`, { excerptId: exA });
    expect(direct.statusCode).toBe(409);

    // C -> B would also close a loop (B -> C -> B): refused.
    const back = await owner.post(`/api/documents/${docC}/references`, { excerptId: exB });
    expect(back.statusCode).toBe(409);

    // A -> C is harmless (C references nothing): allowed.
    expect((await owner.post(`/api/documents/${docA}/references`, { excerptId: exC })).statusCode).toBe(200);
  });

  it('never leaks source content to users without read access', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);
    const editorTok = await tokenFor('editor', 'editor123');
    const viewerTok = await tokenFor('viewer', 'viewer123');

    // Secret source doc: owner only, no memberships for anyone else.
    const secret = `sec-${counter++}`;
    db.docs.set(secret, { id: secret, folder_id: null, title: '内部机密', owner_id: OWNER });
    const secretQuote = '内部令牌轮换规则：每 24 小时。';
    {
      const room = await getRoom(secret);
      const seed = new CrdtDoc();
      await room.ingest(seed.edit('seed', 0, 0, secretQuote), 'seed');
    }
    const reg = await owner.post(`/api/documents/${secret}/excerpts`, { quote: secretQuote, index: 0 });
    const excerptId = (reg.json() as any).excerpt.id;

    // Shared doc: editor can edit, viewer can read; neither can read the source.
    const shared = await makeDoc('共享文档', '# 共享\n');
    expect((await owner.post(`/api/documents/${shared}/references`, { excerptId })).statusCode).toBe(200);
    await referenceCoordinator.settle();

    // Owner (source access) gets the real content.
    const ownerRefs = await refsFor(ownerTok, shared);
    expect(ownerRefs.find((x) => x.excerptId === excerptId).content).toBe(secretQuote);

    // Editor (body-edit right on the shared doc, no source access) does not.
    const editorRefs = await refsFor(editorTok, shared);
    const er = editorRefs.find((x) => x.excerptId === excerptId);
    expect(er.allowed).toBe(false);
    expect(er.content).toBe('');
    expect(JSON.stringify(editorRefs)).not.toContain(secretQuote);

    // Viewer likewise; and the payload still names the source for the placeholder.
    const viewerRefs = await refsFor(viewerTok, shared);
    const vr = viewerRefs.find((x) => x.excerptId === excerptId);
    expect(vr.allowed).toBe(false);
    expect(vr.content).toBe('');
    expect(vr.sourceTitle).toBe('内部机密');

    // A user without source access may not create a reference to it either.
    const editor = await asUser(editorTok);
    const ins = await editor.post(`/api/documents/${shared}/references`, { excerptId });
    expect(ins.statusCode).toBe(403);

    // Reviewer/viewer roles cannot insert reference blocks (no body-edit right).
    const reviewerTok = await tokenFor('reviewer', 'reviewer123');
    const reviewer = await asUser(reviewerTok);
    const ownExcerpt = ((await owner.post(`/api/documents/${shared}/excerpts`, { quote: '# 共享', index: 0 })).json() as any).excerpt.id;
    expect((await reviewer.post(`/api/documents/${shared}/references`, { excerptId: ownExcerpt })).statusCode).toBe(403);
    const viewer = await asUser(viewerTok);
    expect((await viewer.post(`/api/documents/${shared}/references`, { excerptId: ownExcerpt })).statusCode).toBe(403);
  });

  it('rejects excerpt registration from roles without body-edit rights', async () => {
    const docId = await makeDoc('登记权限', '可登记的片段。\n');
    const reviewerTok = await tokenFor('reviewer', 'reviewer123');
    const reviewer = await asUser(reviewerTok);
    const res = await reviewer.post(`/api/documents/${docId}/excerpts`, {
      quote: '可登记的片段。',
      index: 0,
    });
    expect(res.statusCode).toBe(403);
  });

  it('drops the edge when the marker is edited out of the body', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const src = await makeDoc('源-边', '被引用的片段内容。\n');
    const refDoc = await makeDoc('引用-边', '# 正文\n');
    const reg = await owner.post(`/api/documents/${src}/excerpts`, {
      quote: '被引用的片段内容。',
      index: 0,
    });
    const excerptId = (reg.json() as any).excerpt.id;
    await owner.post(`/api/documents/${refDoc}/references`, { excerptId });
    await referenceCoordinator.settle();
    expect((await refsFor(ownerTok, refDoc)).some((r) => r.excerptId === excerptId)).toBe(true);

    // Delete the marker text itself from the referring document.
    const room = await getRoom(refDoc);
    const text = room.text();
    const m = text.match(/\[\[ref:[A-Za-z0-9_-]+\]\]/)!;
    await editDoc(refDoc, text.indexOf(m[0]), m[0].length, '');

    const refs = await refsFor(ownerTok, refDoc);
    expect(refs.find((r) => r.excerptId === excerptId)).toBeUndefined();
    // Further source edits no longer fan out to this document.
    const seen: string[][] = [];
    const off = referenceCoordinator.subscribe((ev) => seen.push(ev.docIds));
    await editDoc(src, 0, 0, '前缀。');
    off();
    expect(seen.flat().includes(refDoc)).toBe(false);
  });

  it('revives an invalidated excerpt when a rollback restores the passage', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const src = await makeDoc('源-回滚', '回滚前存在的共享片段。\n');
    const refDoc = await makeDoc('引用-回滚', '# 正文\n');
    const quote = '回滚前存在的共享片段。';
    const reg = await owner.post(`/api/documents/${src}/excerpts`, { quote, index: 0 });
    const excerptId = (reg.json() as any).excerpt.id;
    await owner.post(`/api/documents/${refDoc}/references`, { excerptId });
    await referenceCoordinator.settle();

    // Snapshot, delete the passage, then roll back to the snapshot.
    const snap = (await owner.post(`/api/documents/${src}/snapshots`, { name: '基线' })).json().version;
    await editDoc(src, 0, quote.length, '');
    let refs = await refsFor(ownerTok, refDoc);
    expect(refs.find((r) => r.excerptId === excerptId).status).toBe('invalid');

    await owner.post(`/api/documents/${src}/rollback`, { versionId: snap.id });
    await referenceCoordinator.settle(src);
    refs = await refsFor(ownerTok, refDoc);
    const r = refs.find((x) => x.excerptId === excerptId);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe(quote);
  });

  it('recovers reference state after a reboot from persisted rows only', async () => {
    const ownerTok = await tokenFor('owner', 'owner123');
    const owner = await asUser(ownerTok);

    const src = await makeDoc('源-持久', '持久化的共享片段。\n');
    const refDoc = await makeDoc('引用-持久', '# 正文\n');
    const reg = await owner.post(`/api/documents/${src}/excerpts`, {
      quote: '持久化的共享片段。',
      index: 0,
    });
    const excerptId = (reg.json() as any).excerpt.id;
    await owner.post(`/api/documents/${refDoc}/references`, { excerptId });
    await referenceCoordinator.settle();

    // Simulate a service restart: all in-memory dependency state is dropped
    // and rebuilt from the persisted edges/excerpts alone.
    await referenceCoordinator.reboot();

    // Propagation still works: editing the source reaches the referrer.
    const room = await getRoom(src);
    const at = room.text().indexOf('共享片段');
    await editDoc(src, at, 4, '共享段落');
    const refs = await refsFor(ownerTok, refDoc);
    const r = refs.find((x) => x.excerptId === excerptId);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe('持久化的共享段落。');

    // Cycle detection also survives the reboot (edge was rebuilt from rows).
    const reg2 = await owner.post(`/api/documents/${refDoc}/excerpts`, {
      quote: '# 正文',
      index: 0,
    });
    const excerpt2 = (reg2.json() as any).excerpt.id;
    const back = await owner.post(`/api/documents/${src}/references`, { excerptId: excerpt2 });
    expect(back.statusCode).toBe(409);
  });
});
