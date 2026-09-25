import { useMemo } from 'react';
import { marked } from 'marked';
import { expandMarkdown, type RenderBlock } from '@collabmd/core';
import type { RefState } from '../api/client';

marked.setOptions({ gfm: true, breaks: false });

function renderMd(md: string): string {
  // marked (GFM) renders headings, bold/italic, ordered/unordered lists, code
  // blocks, tables, blockquotes, links and task-list checkboxes natively.
  return marked.parse(md, { async: false }) as string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render expanded blocks to HTML. Reference blocks are pre-rendered here (not
 * passed through marked) so the compact source markers never leak into the
 * output and nested references compose recursively.
 */
function renderBlocks(blocks: RenderBlock[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.kind === 'md') {
      out += renderMd(b.markdown);
      continue;
    }
    const r = b.ref;
    const src = escapeHtml(r.sourceTitle || '未知来源');
    if (!r.allowed) {
      out +=
        `<div class="ref-block ref-forbidden">` +
        `<div class="ref-head">🔗 引用自《${src}》</div>` +
        `<div class="ref-note">🔒 无权查看此引用来源</div></div>`;
    } else if (b.cycleGuard) {
      out +=
        `<div class="ref-block ref-invalid">` +
        `<div class="ref-head">🔗 引用自《${src}》</div>` +
        `<div class="ref-note">⚠ 检测到循环引用，已停止展开</div></div>`;
    } else if (r.status === 'invalid') {
      out +=
        `<div class="ref-block ref-invalid">` +
        `<div class="ref-head">🔗 引用自《${src}》<span class="ref-tag">已失效</span></div>` +
        `<div class="ref-note">源内容已被删除，以下为最后可见的内容</div>` +
        `<div class="ref-body">${renderMd(r.content)}</div></div>`;
    } else {
      out +=
        `<div class="ref-block">` +
        `<div class="ref-head">🔗 引用自《${src}》<span class="ref-tag live">实时同步</span></div>` +
        `<div class="ref-body">${renderBlocks(b.blocks)}</div></div>`;
    }
  }
  return out;
}

interface Props {
  text: string;
  /** Live references keyed by excerpt id (from the collaboration session). */
  refs: Record<string, RefState>;
  scrollRef?: React.Ref<HTMLDivElement>;
}

export function Preview({ text, refs, scrollRef }: Props) {
  const html = useMemo(
    () => renderBlocks(expandMarkdown(text, (id) => refs[id])),
    [text, refs],
  );
  return (
    <div className="scroll" ref={scrollRef}>
      <div className="preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
