import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function waitForDatabase(retries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('database did not become ready in time');
}

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      pass_hash  TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      owner_id   TEXT NOT NULL REFERENCES users(id),
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
      title       TEXT NOT NULL,
      owner_id    TEXT NOT NULL REFERENCES users(id),
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doc_members (
      doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role     TEXT NOT NULL,
      PRIMARY KEY (doc_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS doc_ops (
      doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      seq      BIGINT NOT NULL,
      op       JSONB NOT NULL,
      author   TEXT NOT NULL,
      PRIMARY KEY (doc_id, seq)
    );

    CREATE TABLE IF NOT EXISTS versions (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      name       TEXT,
      op_offset  BIGINT NOT NULL,
      based_on   TEXT,
      author     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      quote      TEXT NOT NULL,
      anchor_idx INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'anchored',
      thread_state TEXT NOT NULL DEFAULT 'open',
      author     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comment_replies (
      id         TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    -- Live cross-document references.
    -- excerpts: a passage registered in a source document. The primary anchor
    -- is the pair of CRDT character ids at the passage boundaries (immune to
    -- shifts and interior rewrites); quote/anchor_idx are the fuzzy fallback
    -- when the boundary characters themselves get deleted.
    CREATE TABLE IF NOT EXISTS excerpts (
      id           TEXT PRIMARY KEY,
      doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      quote        TEXT NOT NULL,
      anchor_idx   INTEGER NOT NULL,
      start_id     JSONB,
      end_id       JSONB,
      status       TEXT NOT NULL DEFAULT 'anchored',
      last_content TEXT NOT NULL,
      deleted      BOOLEAN NOT NULL DEFAULT FALSE,
      author       TEXT NOT NULL,
      created_at   BIGINT NOT NULL
    );

    -- ref_edges: which document embeds a reference to which excerpt.
    -- Reconciled from the reference markers actually present in each body, so
    -- rows disappear when the last marker is edited out.
    CREATE TABLE IF NOT EXISTS ref_edges (
      doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      excerpt_id TEXT NOT NULL REFERENCES excerpts(id) ON DELETE CASCADE,
      PRIMARY KEY (doc_id, excerpt_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ops_doc ON doc_ops(doc_id, seq);
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_id);
    CREATE INDEX IF NOT EXISTS idx_excerpts_doc ON excerpts(doc_id);
    CREATE INDEX IF NOT EXISTS idx_ref_edges_excerpt ON ref_edges(excerpt_id);
  `);
}
