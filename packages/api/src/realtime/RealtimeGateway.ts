import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { referencedSnippetIds, type Op } from '@collabmd/core';
import { repo } from '../repo.js';
import { redis, presenceKey } from '../redis.js';
import { roleCan, type Role } from '../config.js';
import { getRoom, peekRoom, type DocumentRoom } from './DocumentRoom.js';
import { commentService } from '../services/commentService.js';
import { referenceService } from '../services/referenceService.js';
import { referencePropagator } from './ReferencePropagator.js';
import type { ClientMsg, RefWire, PresenceUser, ServerMsg } from './protocol.js';

interface Session {
  ws: WebSocket;
  docId: string;
  userId: string;
  username: string;
  color: string;
  role: Role;
  cursor: number;
  selStart: number;
  selEnd: number;
}

/**
 * Realtime gateway. One WSS shared by all docs; the first URL path segment is
 * the document id (`/ws/:docId?token=...`). Presence is mirrored to Redis so
 * multiple API replicas share one view of who is online.
 */
export class RealtimeGateway {
  private wss: WebSocketServer;
  private sessions = new Set<Session>();
  private unsubscribers = new Map<string, () => void>();

  constructor(server: Server, private autoVersionMs: number) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      if (!url.startsWith('/ws/')) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws, req) => this.handle(ws, req.url ?? '', req.headers.cookie ?? ''));
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private async handle(ws: WebSocket, url: string, cookieHeader = ''): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://localhost');
    } catch {
      ws.close(1008, 'bad url');
      return;
    }
    const docId = parsed.pathname.split('/').filter(Boolean)[1];
    const queryToken = parsed.searchParams.get('token');
    const cookieToken = cookieHeader
      .match(/(?:^|;\s*)cmdtoken=([^;]+)/)?.[1];
    const token = queryToken ?? (cookieToken ? decodeURIComponent(cookieToken) : null);
    if (!docId || !token) {
      ws.close(1008, 'missing doc/token');
      return;
    }
    const userRow = await repo.userForToken(token);
    if (!userRow) {
      ws.close(1008, 'unauthenticated');
      return;
    }
    const role = await repo.getRole(docId, userRow.id);
    if (!role) {
      ws.close(1008, 'forbidden');
      return;
    }

    const room = await getRoom(docId);
    referencePropagator.watch(room);
    const session: Session = {
      ws,
      docId,
      userId: userRow.id,
      username: userRow.username,
      color: userRow.color,
      role,
      cursor: 0,
      selStart: 0,
      selEnd: 0,
    };
    this.sessions.add(session);
    this.ensureRoomSubscription(room);

    const comments = await commentService.listForDoc(docId);
    this.send(ws, {
      t: 'init',
      ops: room.allOps(),
      you: { userId: userRow.id, username: userRow.username, color: userRow.color, role },
      presence: this.presenceList(docId),
      autoVersionMs: this.autoVersionMs,
    });
    // comments ship on the REST shape; gateway pushes anchor nudges only, but
    // initial payload includes them for convenience.
    this.send(ws, {
      t: 'anchors',
      comments: comments.map((c) => ({
        id: c.id,
        quote: c.quote,
        index: c.index,
        end: c.end,
        status: c.status,
        threadState: c.thread_state,
      })),
    });

    // Initial, permission-filtered content for every marker in this document.
    await this.pushRefs(room, session.userId, ws);

    await this.markPresence(session);
    this.broadcastPresence(docId);

    ws.on('message', async (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        this.send(ws, { t: 'pong' });
        return;
      }
      if (msg.t === 'cursor') {
        session.cursor = msg.cursor;
        session.selStart = msg.selStart;
        session.selEnd = msg.selEnd;
        await this.markPresence(session);
        this.broadcastPresence(docId);
        return;
      }
      if (msg.t === 'ops') {
        if (!roleCan.editBody(session.role)) {
          this.send(ws, { t: 'error', message: '当前角色不能编辑正文' });
          return;
        }
        try {
          await room.ingest(msg.ops as Op[], session.userId);
        } catch (e) {
          this.send(ws, { t: 'error', message: `合并失败: ${(e as Error).message}` });
        }
      }
    });

    ws.on('close', async () => {
      this.sessions.delete(session);
      await this.clearPresence(session);
      this.broadcastPresence(docId);
    });
  }

  private ensureRoomSubscription(room: DocumentRoom): void {
    if (this.unsubscribers.has(room.docId)) return;
    const off = room.subscribe((ev) => {
      if (ev.type === 'ops') {
        this.broadcast(room.docId, {
          t: 'ops',
          ops: ev.ops,
          author: ev.author,
          fromVersion: ev.fromVersion,
        });
        void this.pushAnchors(room.docId);
        // Markers are body text: an edit may have inserted/removed one, so
        // refresh each viewer's permission-filtered reference set.
        void this.pushAllRefs(room.docId);
      } else if (ev.type === 'anchors') {
        void this.pushAnchors(room.docId);
      } else if (ev.type === 'snippets') {
        // A snippet in another document changed. Resolve per distinct viewer
        // (their source-doc roles differ) and send only their sockets.
        void this.pushChangedRefs(room.docId, ev.snippetIds);
      }
    });
    this.unsubscribers.set(room.docId, off);
  }

  private async pushAnchors(docId: string): Promise<void> {
    const comments = await commentService.listForDoc(docId);
    this.broadcast(docId, {
      t: 'anchors',
      comments: comments.map((c) => ({
        id: c.id,
        quote: c.quote,
        index: c.index,
        end: c.end,
        status: c.status,
        threadState: c.thread_state,
      })),
    });
  }

  // ---- cross-document references (permission-filtered, targeted pushes) ----

  /** Resolve the markers currently present in a document to snippet ids. */
  private markerSnippetIds(room: DocumentRoom): string[] {
    return referencedSnippetIds(room.text());
  }

  /** Build one viewer's RefWire[] for the given snippet ids (or all markers). */
  private async resolveRefs(
    docId: string,
    userId: string,
    snippetIds?: string[],
  ): Promise<RefWire[]> {
    const room = await getRoom(docId);
    const ids = snippetIds ?? this.markerSnippetIds(room);
    if (ids.length === 0) return [];
    const views = await referenceService.viewForMany(ids, async (sourceDocId) =>
      repo.getRole(sourceDocId, userId),
    );
    return views.map((v) => ({
      snippetId: v.snippetId,
      sourceDocId: v.sourceDocId,
      sourceTitle: v.sourceTitle,
      status: v.status,
      content: v.content,
    }));
  }

  private async pushRefs(
    room: DocumentRoom,
    userId: string,
    ws: WebSocket,
    snippetIds?: string[],
  ): Promise<void> {
    try {
      const refs = await this.resolveRefs(room.docId, userId, snippetIds);
      this.send(ws, { t: 'refs', refs });
    } catch (e) {
      console.error('[refs] push failed', room.docId, e);
    }
  }

  /** Re-send the full reference set to every open socket of a document. */
  private async pushAllRefs(docId: string): Promise<void> {
    const room = peekRoom(docId);
    if (!room) return;
    const userIds = [
      ...new Set(
        [...this.sessions].filter((s) => s.docId === docId).map((s) => s.userId),
      ),
    ];
    for (const userId of userIds) {
      const refs = await this.resolveRefs(docId, userId);
      const data = JSON.stringify({ t: 'refs', refs });
      for (const s of this.sessions) {
        if (s.docId === docId && s.userId === userId && s.ws.readyState === WebSocket.OPEN) {
          s.ws.send(data);
        }
      }
    }
  }

  /** Push only the changed snippets to each distinct viewer's sockets. */
  private async pushChangedRefs(docId: string, snippetIds: string[]): Promise<void> {
    const userIds = [
      ...new Set(
        [...this.sessions].filter((s) => s.docId === docId).map((s) => s.userId),
      ),
    ];
    for (const userId of userIds) {
      const refs = await this.resolveRefs(docId, userId, snippetIds);
      const data = JSON.stringify({ t: 'refs', refs });
      for (const s of this.sessions) {
        if (s.docId === docId && s.userId === userId && s.ws.readyState === WebSocket.OPEN) {
          s.ws.send(data);
        }
      }
    }
  }

  // ---- presence (Redis HASH per doc) ----
  private async markPresence(s: Session): Promise<void> {
    const data: Omit<PresenceUser, 'userId'> = {
      username: s.username,
      color: s.color,
      role: s.role,
      cursor: s.cursor,
      selStart: s.selStart,
      selEnd: s.selEnd,
    };
    await redis().hset(presenceKey(s.docId), s.userId, JSON.stringify(data));
    await redis().expire(presenceKey(s.docId), 60);
  }

  private async clearPresence(s: Session): Promise<void> {
    // Only clear if this was the last socket for that user.
    const stillOnline = [...this.sessions].some(
      (x) => x.docId === s.docId && x.userId === s.userId && x !== s,
    );
    if (!stillOnline) await redis().hdel(presenceKey(s.docId), s.userId);
  }

  private presenceList(docId: string): PresenceUser[] {
    // Synchronous sessions are authoritative for the snapshot we return;
    // include Redis entries asynchronously via broadcast afterwards.
    const byUser = new Map<string, PresenceUser>();
    for (const s of this.sessions) {
      if (s.docId !== docId) continue;
      byUser.set(s.userId, {
        userId: s.userId,
        username: s.username,
        color: s.color,
        role: s.role,
        cursor: s.cursor,
        selStart: s.selStart,
        selEnd: s.selEnd,
      });
    }
    return [...byUser.values()];
  }

  private broadcastPresence(docId: string): void {
    // Merge Redis presence (other replicas) with local sessions.
    void redis()
      .hgetall(presenceKey(docId))
      .then((entries) => {
        const merged = new Map<string, PresenceUser>();
        for (const [userId, raw] of Object.entries(entries)) {
          try {
            merged.set(userId, { userId, ...(JSON.parse(raw) as Omit<PresenceUser, 'userId'>) });
          } catch {
            /* ignore malformed */
          }
        }
        for (const s of this.sessions) {
          if (s.docId !== docId) continue;
          merged.set(s.userId, {
            userId: s.userId,
            username: s.username,
            color: s.color,
            role: s.role,
            cursor: s.cursor,
            selStart: s.selStart,
            selEnd: s.selEnd,
          });
        }
        this.broadcast(docId, { t: 'presence', users: [...merged.values()] });
      });
  }

  private broadcast(docId: string, msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const s of this.sessions) {
      if (s.docId === docId && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(data);
      }
    }
  }
}
