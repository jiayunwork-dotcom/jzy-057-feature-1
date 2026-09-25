import { CrdtDoc, refMarker } from '@collabmd/core';
import { pool } from './db.js';
import { repo } from './repo.js';
import { hashPassword, newId } from './auth.js';

const STARTER = `# 协作评审示例文档

欢迎来到 **CollabMD** —— 一篇可以多人*实时协作*的 Markdown 技术文档。

## 核心能力

1. CRDT 实时合并，离线编辑自动收敛
2. 贴着正文的评审批注与讨论线程
3. 增量版本、命名快照、差异对比与一键回滚

\`\`\`ts
// 每个字符都有全局唯一标识
const id: Id = [lamport, clientId];
\`\`\`

> 选中这一段文字，点击「加批注」即可开始评审。

## 部署前置条件

- Node.js 20.x（与 CI 保持一致）
- Postgres 16 与 Redis 7 已就绪
- 环境变量 DATABASE_URL / REDIS_URL 已配置

| 角色 | 正文 | 批注 | 管理 |
| --- | --- | --- | --- |
| 所有者 | ✅ | ✅ | ✅ |
| 编辑者 | ✅ | ✅ | ❌ |
| 评审者 | ❌ | ✅ | ❌ |
| 只读者 | ❌ | ❌ | ❌ |

- [x] 注册账号
- [ ] 打开本文档
- [ ] 邀请协作者并分配角色
- [ ] 创建一个命名快照

[项目文档约定](https://example.com/style-guide) 评审时请遵守。
`;

/** Passage registered as the demo's shareable excerpt. */
const DEMO_EXCERPT_QUOTE = `- Node.js 20.x（与 CI 保持一致）
- Postgres 16 与 Redis 7 已就绪
- 环境变量 DATABASE_URL / REDIS_URL 已配置`;

interface SeedUser {
  username: string;
  password: string;
  color: string;
}

const USERS: SeedUser[] = [
  { username: 'owner', password: 'owner123', color: '#4363d8' },
  { username: 'editor', password: 'editor123', color: '#3cb44b' },
  { username: 'reviewer', password: 'reviewer123', color: '#f58231' },
  { username: 'viewer', password: 'viewer123', color: '#911eb4' },
];

export async function seed(): Promise<void> {
  const existing = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (existing.rows[0].c > 0) return;

  const ids: Record<string, string> = {};
  for (const u of USERS) {
    const id = newId('u');
    ids[u.username] = id;
    await repo.createUser({
      id,
      username: u.username,
      pass_hash: hashPassword(u.password),
      color: u.color,
    });
  }

  const folder = await repo.createFolder(newId('f'), null, '设计文档', ids.owner);
  const sub = await repo.createFolder(newId('f'), folder.id, '评审中', ids.owner);
  const doc = await repo.createDoc(newId('d'), sub.id, 'CollabMD 快速上手', ids.owner);

  // Seed the CRDT op log with the starter markdown.
  const crdt = new CrdtDoc();
  const ops = crdt.edit('seed', 0, 0, STARTER);
  await repo.appendOps(doc.id, 0, ops, 'seed');

  // Reviewer/editor/viewer memberships on the demo doc.
  await repo.setRole(doc.id, ids.editor, 'editor');
  await repo.setRole(doc.id, ids.reviewer, 'reviewer');
  await repo.setRole(doc.id, ids.viewer, 'viewer');

  // Baseline snapshot + one auto version.
  await repo.insertVersion({
    id: newId('v'),
    doc_id: doc.id,
    kind: 'snapshot',
    name: '初始基线',
    op_offset: ops.length,
    based_on: null,
    author: 'seed',
    created_at: Date.now() - 60_000,
  });

  // Register the prerequisites passage as a referenceable excerpt.
  const excerptId = newId('ex');
  const excerptIdx = STARTER.indexOf(DEMO_EXCERPT_QUOTE);
  const starterIds = crdt.visibleIds();
  await repo.insertExcerpt({
    id: excerptId,
    doc_id: doc.id,
    quote: DEMO_EXCERPT_QUOTE,
    anchor_idx: excerptIdx,
    start_id: starterIds[excerptIdx] ?? null,
    end_id: starterIds[excerptIdx + DEMO_EXCERPT_QUOTE.length - 1] ?? null,
    status: 'anchored',
    last_content: DEMO_EXCERPT_QUOTE,
    deleted: false,
    author: ids.owner,
    created_at: Date.now(),
  });

  // A restricted doc only the owner can read, with its own registered excerpt.
  // The draft below references it too, so users without access see the
  // reference degrade to "无权查看此引用来源" instead of leaking content.
  const SECRET_QUOTE = '内部接口令牌每 24 小时轮换一次，切勿写入公开文档。';
  const secretDoc = await repo.createDoc(newId('d'), null, '内部规范（仅所有者）', ids.owner);
  const secretText = `# 内部规范\n\n${SECRET_QUOTE}\n`;
  const secretCrdt = new CrdtDoc();
  await repo.appendOps(secretDoc.id, 0, secretCrdt.edit('seed', 0, 0, secretText), 'seed');
  const secretExcerptId = newId('ex');
  const secretIdx = secretText.indexOf(SECRET_QUOTE);
  const secretIds = secretCrdt.visibleIds();
  await repo.insertExcerpt({
    id: secretExcerptId,
    doc_id: secretDoc.id,
    quote: SECRET_QUOTE,
    anchor_idx: secretIdx,
    start_id: secretIds[secretIdx] ?? null,
    end_id: secretIds[secretIdx + SECRET_QUOTE.length - 1] ?? null,
    status: 'anchored',
    last_content: SECRET_QUOTE,
    deleted: false,
    author: ids.owner,
    created_at: Date.now(),
  });

  // A second demo doc owned by editor to show shared trees — it embeds live
  // references to both excerpts above.
  const draft = await repo.createDoc(newId('d'), folder.id, '接口草案（编辑者所有）', ids.editor);
  const draftText = `# 接口草案

## 环境要求

本文档与《CollabMD 快速上手》共享同一份部署前置条件；源段落更新后，下面的引用块会实时跟随：

${refMarker(excerptId)}

## 内部约定（无权来源演示）

下面引用的来源文档仅所有者可读；没有权限的协作者只会看到占位提示：

${refMarker(secretExcerptId)}

## 接口约定

（草稿，待补充）
`;
  const draftCrdt = new CrdtDoc();
  const draftOps = draftCrdt.edit('seed', 0, 0, draftText);
  await repo.appendOps(draft.id, 0, draftOps, 'seed');
  await repo.reconcileEdges(draft.id, [excerptId, secretExcerptId]);
  await repo.setRole(draft.id, ids.owner, 'editor');
  await repo.setRole(draft.id, ids.reviewer, 'reviewer');
  await repo.setRole(draft.id, ids.viewer, 'viewer');

  console.log('seed complete: owner/editor/reviewer/viewer with demo doc');
}
