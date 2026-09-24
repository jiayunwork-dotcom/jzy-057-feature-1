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
  snippets: new Map<string, any>(),
  edges: [] as Array<{ snippet_id: string; ref_doc_id: string }>,
};

vi.mock('../src/repo.js', () => ({
  repo: {
    userForToken: async (t: string) => {
      const uid = db.tokens.get(t);
      return uid ? db.users.get(uid) ?? null : null;
    },
    listUsers: async () =>
      [...db.users.values()].map(({ id, username, color }) => ({ id, username, color })),
    getRole: async (docId: string, uid: string) => {
      const doc = db.docs.get(docId);
      if (!doc) return null;
      return doc.owner_id === uid ? 'owner' : (db.members.get(`${docId}:${uid}`) ?? null);
    },
    getDoc: async (id: string) => db.docs.get(id) ?? null,
    loadOps: async () => [],
    appendOps: vi.fn(async () => undefined),
    listComments: async () => [],
    listReplies: async () => [],
    updateCommentAnchor: vi.fn(),
    listVersions: async () => [],
    insertVersion: vi.fn(),
    listSnippets: async (docId: string) =>
      [...db.snippets.values()].filter((s: any) => s.doc_id === docId),
    getSnippets: async (ids: string[]) =>
      ids.map((id) => db.snippets.get(id)).filter(Boolean),
    getSnippet: async (id: string) => db.snippets.get(id) ?? null,
    insertSnippet: vi.fn(async (s: any) => void db.snippets.set(s.id, s)),
    updateSnippetAnchor: vi.fn(async (id: string, quote: string, idx: number, status: string) => {
      const s = db.snippets.get(id);
      if (s) Object.assign(s, { quote, anchor_idx: idx, status });
    }),
    listAllRefEdges: async () => db.edges,
    listEdgesBySnippet: async (sid: string) =>
      db.edges.filter((e) => e.snippet_id === sid),
    listEdgesByRefDoc: async (rid: string) =>
      db.edges.filter((e) => e.ref_doc_id === rid),
    insertRefEdge: vi.fn(async (sid: string, rid: string) => {
      if (db.edges.some((e) => e.snippet_id === sid && e.ref_doc_id === rid)) return false;
      db.edges.push({ snippet_id: sid, ref_doc_id: rid });
      return true;
    }),
  },
}));

import bcrypt from 'bcryptjs';
import { RealtimeGateway } from '../src/realtime/RealtimeGateway.js';
import { CrdtDoc } from '@collabmd/core';

const DOC = 'realtime-doc';
let port: number;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  hashes.clear();
  db.users.clear();
  db.tokens.clear();
  db.docs.clear();
  db.members.clear();
  db.users.set('u1', {
    id: 'u1',
    username: 'alice',
    pass_hash: bcrypt.hashSync('x', 8),
    color: '#f00',
  });
  db.users.set('u2', {
    id: 'u2',
    username: 'bob',
    pass_hash: bcrypt.hashSync('x', 8),
    color: '#0f0',
  });
  db.tokens.set('tok1', 'u1');
  db.tokens.set('tok2', 'u2');
  db.docs.set(DOC, { id: DOC, owner_id: 'u1' });
  db.members.set(`${DOC}:u2`, 'editor');

  // Cross-document reference fixtures: SOURCE (owned by alice) and REFERENCER
  // (owned by bob). alice can view both; bob can view both as a member.
  db.docs.set('SRC', { id: 'SRC', owner_id: 'u1' });
  db.docs.set('REF', { id: 'REF', owner_id: 'u2' });
  db.members.set('SRC:u2', 'viewer');
  db.members.set('REF:u1', 'viewer');

  server = createServer();
  new RealtimeGateway(server, 30_000);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/${DOC}?token=${token}`);
}

function connectTo(docId: string, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/${docId}?token=${token}`);
}

function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
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

describe('realtime gateway', () => {
  it('streams init, broadcasts remote ops, and syncs colored presence', async () => {
    const aliceInbox: any[] = [];
    const bobInbox: any[] = [];
    const alice = connect('tok1');
    const bob = connect('tok2');
    alice.on('message', (raw: Buffer) => aliceInbox.push(JSON.parse(raw.toString())));
    bob.on('message', (raw: Buffer) => bobInbox.push(JSON.parse(raw.toString())));

    await waitFor(() => aliceInbox.some((m) => m.t === 'init'), 'alice-init');
    const aliceInit = aliceInbox.find((m) => m.t === 'init')!;
    expect(aliceInit.you.username).toBe('alice');
    expect(aliceInit.you.role).toBe('owner');
    await waitFor(() => bobInbox.some((m) => m.t === 'init'), 'bob-init');

    // Both eventually see each other in presence.
    await waitFor(
      () =>
        aliceInbox.some(
          (m) => m.t === 'presence' && m.users.some((u: any) => u.userId === 'u2'),
        ),
      'presence',
    );
    const seenByAlice = aliceInbox
      .filter((m) => m.t === 'presence')
      .find((m) => m.users.some((u: any) => u.userId === 'u2'));
    expect(seenByAlice.users).toHaveLength(2);

    // Bob edits through the socket; Alice receives the converged ops.
    const local = new CrdtDoc();
    const ops = local.edit('u2', 0, 0, 'hi');
    const before = aliceInbox.filter((m) => m.t === 'ops').flatMap((m) => m.ops).length;
    bob.send(JSON.stringify({ t: 'ops', ops }));
    await waitFor(
      () => aliceInbox.filter((m) => m.t === 'ops').flatMap((m) => m.ops).length >= before + ops.length,
      'ops-broadcast',
    );
    const received = aliceInbox.filter((m) => m.t === 'ops').flatMap((m) => m.ops);
    expect(received).toHaveLength(ops.length);

    // Bob moves his cursor/selection; Alice sees the colored presence update.
    bob.send(JSON.stringify({ t: 'cursor', cursor: 1, selStart: 1, selEnd: 2 }));
    bob.send(JSON.stringify({ t: 'cursor', cursor: 2, selStart: 2, selEnd: 2 }));
    await waitFor(
      () =>
        aliceInbox.some(
          (m) =>
            m.t === 'presence' &&
            m.users.find((u: any) => u.userId === 'u2' && u.cursor === 2 && u.selEnd === 2),
        ),
      'cursor-sync',
    );
    const pres = aliceInbox
      .filter((m) => m.t === 'presence')
      .find((m) => m.users.find((u: any) => u.userId === 'u2' && u.cursor === 2));
    const bobPresence = pres.users.find((u: any) => u.userId === 'u2');
    expect(bobPresence.color).toBe('#0f0');
    expect(bobPresence.username).toBe('bob');

    alice.close();
    bob.close();
  }, 10_000);

  it('refuses a bad token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${DOC}?token=nope`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(1008);
  });

  it('propagates a source snippet edit across the document boundary in real time', async () => {
    // 1. Register a snippet in the SOURCE document and an edge REF -> snippet.
    const { referenceService } = await import('../src/services/referenceService.js');
    const { getRoom } = await import('../src/realtime/DocumentRoom.js');

    // A collaborator has the SOURCE document open (this also makes the
    // propagator watch it). Nobody editing REF needs to be in the source room
    // beyond this single socket.
    const sourceSocket = connectTo('SRC', 'tok1');
    const sourceInbox: any[] = [];
    sourceSocket.on('message', (raw: Buffer) => sourceInbox.push(JSON.parse(raw.toString())));
    await waitFor(() => sourceInbox.some((m) => m.t === 'init'), 'src-init');

    const sourceRoom = await getRoom('SRC');
    const seed = new CrdtDoc();
    await sourceRoom.appendSystemOps(seed.edit('s', 0, 0, '部署前置条件：Node 20'), 'u1');
    const snippet = await referenceService.register('SRC', 'u1', '部署前置条件：Node 20', 0, '前置条件');
    expect(snippet.quote).toBe('部署前置条件：Node 20');
    db.edges.push({ snippet_id: snippet.id, ref_doc_id: 'REF' });

    // 2. Pre-place the marker in REF's body, then open a socket for it.
    const refRoom = await getRoom('REF');
    const refSeed = new CrdtDoc();
    const marker = `^ref[${snippet.id}#ref_block1]`;
    await refRoom.appendSystemOps(refSeed.edit('s', 0, 0, `引言\n${marker}\n结尾`), 'u2');

    const refInbox: any[] = [];
    const refSocket = connectTo('REF', 'tok2');
    refSocket.on('message', (raw: Buffer) => refInbox.push(JSON.parse(raw.toString())));

    // Initial push must carry the snippet content verbatim.
    await waitFor(
      () => refInbox.some((m) => m.t === 'refs' && m.refs.some((r: any) => r.snippetId === snippet.id)),
      'initial-refs',
    );
    const initial = refInbox
      .flatMap((m) => (m.t === 'refs' ? m.refs : []))
      .find((r: any) => r.snippetId === snippet.id);
    expect(initial.status).toBe('anchored');
    expect(initial.content).toBe('部署前置条件：Node 20');

    // 3. Edit the snippet IN ITS OWN DOCUMENT (a collaborator is not in REF).
    const editor = new CrdtDoc();
    sourceRoom.allOps().forEach((o) => editor.integrate(o));
    const text = editor.text();
    const idx = text.indexOf('20');
    const editOps = editor.edit('u1', idx, 2, '24');
    await sourceRoom.ingest(editOps, 'u1');

    // 4. The REF socket receives the new content without a refresh.
    await waitFor(
      () =>
        refInbox.some(
          (m) =>
            m.t === 'refs' &&
            m.refs.some((r: any) => r.snippetId === snippet.id && r.content === '部署前置条件：Node 24'),
        ),
      'live-ref-update',
      5000,
    );
    const updated = refInbox
      .flatMap((m) => (m.t === 'refs' ? m.refs : []))
      .find((r: any) => r.snippetId === snippet.id);
    expect(updated.content).toBe('部署前置条件：Node 24');

    // 5. Delete the source snippet wholesale -> the reference degrades to
    //    'lost' but retains the last-seen content.
    const deleter = new CrdtDoc();
    sourceRoom.allOps().forEach((o) => deleter.integrate(o));
    const cur = deleter.text();
    const delOps = deleter.edit('u1', 0, cur.length, '完全不同的内容');
    await sourceRoom.ingest(delOps, 'u1');
    await waitFor(
      () =>
        refInbox.some(
          (m) =>
            m.t === 'refs' &&
            m.refs.some((r: any) => r.snippetId === snippet.id && r.status === 'lost'),
        ),
      'lost-ref',
      5000,
    );
    const lost = refInbox
      .flatMap((m) => (m.t === 'refs' ? m.refs : []))
      .find((r: any) => r.snippetId === snippet.id && r.status === 'lost');
    expect(lost.content).toBeTruthy(); // last-known content retained

    refSocket.close();
    sourceSocket.close();
  }, 15_000);
});
