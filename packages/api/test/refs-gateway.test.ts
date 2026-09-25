import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

vi.mock('../src/db.js', () => ({ pool: {} }));

const hashes = new Map<string, Map<string, string>>();
vi.mock('../src/redis.js', () => ({
  connectRedis: vi.fn(),
  presenceKey: (docId: string) => `presence:${docId}`,
  redis: () => ({
    hset: async (k: string, f: string, v: string) => {
      if (!hashes.has(k)) hashes.set(k, new Map());
      hashes.get(k)!.set(f, v);
    },
    hgetall: async (k: string) => Object.fromEntries(hashes.get(k) ?? new Map()),
    hdel: async (k: string, f: string) => void hashes.get(k)?.delete(f),
    expire: async () => undefined,
  }),
}));

const db = {
  users: new Map<string, any>(),
  tokens: new Map<string, string>(),
  docs: new Map<string, any>(),
  members: new Map<string, string>(),
  ops: new Map<string, any[]>(),
  excerpts: new Map<string, any>(),
  edges: new Set<string>(),
};

vi.mock('../src/repo.js', () => ({
  repo: {
    userForToken: async (t: string) => {
      const uid = db.tokens.get(t);
      return uid ? db.users.get(uid) ?? null : null;
    },
    listUsers: async () =>
      [...db.users.values()].map(({ id, username, color }) => ({ id, username, color })),
    getDoc: async (id: string) => db.docs.get(id) ?? null,
    getRole: async (docId: string, uid: string) => {
      const doc = db.docs.get(docId);
      if (!doc) return null;
      return doc.owner_id === uid ? 'owner' : (db.members.get(`${docId}:${uid}`) ?? null);
    },
    loadOps: async (d: string) => db.ops.get(d) ?? [],
    appendOps: async (d: string, start: number, ops: any[]) => {
      const arr = db.ops.get(d) ?? [];
      arr.splice(start, ops.length, ...ops);
      db.ops.set(d, arr);
    },
    listComments: async () => [],
    listReplies: async () => [],
    updateCommentAnchor: vi.fn(),
    listVersions: async () => [],
    insertVersion: vi.fn(),
    // reference layer
    insertExcerpt: async (e: any) => void db.excerpts.set(e.id, { ...e }),
    getExcerpt: async (id: string) => db.excerpts.get(id) ?? null,
    listExcerpts: async (docId: string) =>
      [...db.excerpts.values()].filter((e) => e.doc_id === docId && !e.deleted),
    listExcerptsByIds: async (ids: string[]) =>
      ids.map((id) => db.excerpts.get(id)).filter(Boolean),
    listAllExcerpts: async () => [...db.excerpts.values()],
    updateExcerptAnchor: async (id: string, idx: number, status: string, last: string, s: any, e: any) => {
      const row = db.excerpts.get(id);
      if (row) Object.assign(row, { anchor_idx: idx, status, last_content: last, start_id: s, end_id: e });
    },
    softDeleteExcerpt: async (id: string) => {
      const row = db.excerpts.get(id);
      if (row) row.deleted = true;
    },
    reconcileEdges: async (docId: string, excerptIds: string[]) => {
      for (const key of [...db.edges]) {
        const [d, e] = key.split('::');
        if (d === docId && !excerptIds.includes(e)) db.edges.delete(key);
      }
      for (const e of excerptIds) db.edges.add(`${docId}::${e}`);
    },
    listEdgesForDoc: async (docId: string) =>
      [...db.edges].filter((k) => k.startsWith(`${docId}::`))
        .map((k) => ({ doc_id: docId, excerpt_id: k.split('::')[1] })),
    listEdgesReferencing: async (ids: string[]) =>
      [...db.edges].map((k) => k.split('::'))
        .filter(([, e]) => ids.includes(e))
        .map(([d, e]) => ({ doc_id: d, excerpt_id: e })),
    listAllEdges: async () =>
      [...db.edges].map((k) => {
        const [d, e] = k.split('::');
        return { doc_id: d, excerpt_id: e };
      }),
    listReferencedExcerpts: async (docId: string) =>
      [...db.edges].filter((k) => k.startsWith(`${docId}::`))
        .map((k) => db.excerpts.get(k.split('::')[1])).filter(Boolean),
  },
}));

import bcrypt from 'bcryptjs';
import { RealtimeGateway } from '../src/realtime/RealtimeGateway.js';
import { getRoom } from '../src/realtime/DocumentRoom.js';
import { referenceCoordinator } from '../src/realtime/ReferenceCoordinator.js';
import { excerptService } from '../src/services/excerptService.js';
import { CrdtDoc, refMarker } from '@collabmd/core';

const SRC = 'ws-src';
const REF = 'ws-ref';
const OTHER = 'ws-other';
const QUOTE = '实时共享的部署前置条件。';

let port: number;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  db.users.set('u1', { id: 'u1', username: 'alice', pass_hash: bcrypt.hashSync('x', 8), color: '#f00' });
  db.users.set('u2', { id: 'u2', username: 'bob', pass_hash: bcrypt.hashSync('x', 8), color: '#0f0' });
  db.tokens.set('tok1', 'u1');
  db.tokens.set('tok2', 'u2');
  db.docs.set(SRC, { id: SRC, title: '来源文档', owner_id: 'u1' });
  db.docs.set(REF, { id: REF, title: '引用文档', owner_id: 'u1' });
  db.docs.set(OTHER, { id: OTHER, title: '无关文档', owner_id: 'u1' });
  db.members.set(`${REF}:u2`, 'editor'); // bob edits REF but cannot read SRC

  // Source body + registered excerpt.
  const srcRoom = await getRoom(SRC);
  const seedSrc = new CrdtDoc();
  await srcRoom.ingest(seedSrc.edit('seed', 0, 0, `开头\n${QUOTE}\n结尾`), 'seed');
  const quoteIdx = `开头\n`.length;
  const excerpt = await excerptService.register(SRC, 'u1', QUOTE, quoteIdx);

  // Referring body: embed the compact marker.
  const refRoom = await getRoom(REF);
  const seedRef = new CrdtDoc();
  await refRoom.ingest(seedRef.edit('seed', 0, 0, `# 引用文档\n\n${refMarker(excerpt.id)}\n`), 'seed');
  await referenceCoordinator.settle();

  server = createServer();
  new RealtimeGateway(server, 30_000);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(docId: string, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/${docId}?token=${token}`);
}

function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) resolve();
      else timer = setTimeout(tick, 20);
    };
    let timer = setTimeout(tick, 0);
    setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(`timeout @${label}`));
    }, timeoutMs);
  });
}

describe('cross-document reference propagation over the realtime channel', () => {
  it('pushes fresh per-viewer snapshots to exactly the affected documents', async () => {
    const inboxes = { a: [] as any[], b: [] as any[], c: [] as any[], d: [] as any[] };
    const a = connect(SRC, 'tok1'); // alice on the source doc
    const b = connect(REF, 'tok2'); // bob on the referrer (no source access)
    const c = connect(OTHER, 'tok1'); // alice on an unrelated doc
    const d = connect(REF, 'tok1'); // alice on the referrer
    a.on('message', (r: Buffer) => inboxes.a.push(JSON.parse(r.toString())));
    b.on('message', (r: Buffer) => inboxes.b.push(JSON.parse(r.toString())));
    c.on('message', (r: Buffer) => inboxes.c.push(JSON.parse(r.toString())));
    d.on('message', (r: Buffer) => inboxes.d.push(JSON.parse(r.toString())));

    await waitFor(() => inboxes.d.some((m) => m.t === 'init'), 'd-init');
    await waitFor(() => inboxes.b.some((m) => m.t === 'refs'), 'b-init-refs');
    await waitFor(() => inboxes.c.some((m) => m.t === 'refs'), 'c-init-refs');

    // Initial snapshots: alice sees content, bob is permission-filtered.
    const dInit = inboxes.d.find((m) => m.t === 'refs');
    expect(dInit.refs).toHaveLength(1);
    expect(dInit.refs[0].content).toBe(QUOTE);
    expect(dInit.refs[0].sourceTitle).toBe('来源文档');
    const bInit = inboxes.b.find((m) => m.t === 'refs');
    expect(bInit.refs[0].allowed).toBe(false);
    expect(bInit.refs[0].content).toBe('');
    expect(JSON.stringify(bInit)).not.toContain(QUOTE);

    // Alice edits the referenced passage in the source document.
    const local = new CrdtDoc();
    const aInit = inboxes.a.find((m) => m.t === 'init');
    for (const op of aInit.ops) local.integrate(op);
    const at = local.text().indexOf('部署前置条件');
    const ops = local.edit('u1', at, 6, '上线检查清单');
    a.send(JSON.stringify({ t: 'ops', ops }));

    // Both referrer sessions get a fresh snapshot without any reconnect...
    const want = '实时共享的上线检查清单。';
    await waitFor(
      () => inboxes.d.some((m) => m.t === 'refs' && m.refs[0]?.content === want),
      'd-live-update',
    );
    await waitFor(
      () => inboxes.b.filter((m) => m.t === 'refs').length >= 2,
      'b-live-update',
    );
    const bLatest = inboxes.b.filter((m) => m.t === 'refs').pop();
    expect(bLatest.refs[0].allowed).toBe(false);
    expect(bLatest.refs[0].content).toBe('');
    expect(JSON.stringify(bLatest)).not.toContain(want);

    // ...and the unrelated document's session is never disturbed.
    await new Promise((r) => setTimeout(r, 300));
    expect(inboxes.c.filter((m) => m.t === 'refs')).toHaveLength(1); // init only

    a.close();
    b.close();
    c.close();
    d.close();
  }, 15_000);
});
