import { describe, expect, it } from 'vitest';
import {
  ReferenceGraph,
  expandMarkdown,
  parseRefMarkers,
  refMarker,
  referencedExcerptIds,
  resolveExcerpt,
  type ResolvedRef,
} from '../src/ref/index.js';

describe('reference markers', () => {
  it('parses compact markers with positions and ids in order', () => {
    const text = `intro\n${refMarker('ex_a1')}\nmiddle ${refMarker('ex_b2')} tail`;
    const markers = parseRefMarkers(text);
    expect(markers.map((m) => m.excerptId)).toEqual(['ex_a1', 'ex_b2']);
    expect(text.slice(markers[0].start, markers[0].end)).toBe('[[ref:ex_a1]]');
    expect(referencedExcerptIds(text)).toEqual(['ex_a1', 'ex_b2']);
  });

  it('dedupes repeated references to the same excerpt', () => {
    const text = `${refMarker('ex_x')} and again ${refMarker('ex_x')}`;
    expect(referencedExcerptIds(text)).toEqual(['ex_x']);
  });

  it('ignores lookalikes that are not markers', () => {
    expect(parseRefMarkers('[[ref:]] [ref:ex_a] [[ref: ex_a]]')).toEqual([]);
  });
});

describe('excerpt anchor following', () => {
  it('slides with text inserted before it, still covering the same passage', () => {
    const before = 'Title\n共享的前置条件段落。\nFooter';
    const index = before.indexOf('共享的前置条件段落。');
    const anchor = { quote: '共享的前置条件段落。', index, status: 'anchored' as const };

    const after = `Title\n${'插入的前言。'.repeat(30)}\n共享的前置条件段落。\nFooter`;
    const r = resolveExcerpt(anchor, after);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe('共享的前置条件段落。');
    expect(after.slice(r.index, r.end)).toBe('共享的前置条件段落。');
  });

  it('follows the closest passage after a partial rewrite', () => {
    const before = '部署前请确认 Node 版本为 18。';
    const anchor = {
      quote: '部署前请确认 Node 版本为 18。',
      index: 0,
      status: 'anchored' as const,
    };
    const after = '部署前请确认 Node 版本为 20，并开启核心包。';
    const r = resolveExcerpt(anchor, after);
    expect(r.status).toBe('anchored');
    // Follows the closest rewritten passage rather than drifting off it.
    expect(r.content).toContain('部署前请确认');
    expect(r.content).toContain('版本为');
    expect(after).toContain(r.content);
  });

  it('degrades to invalid with the last content kept when deleted wholesale', () => {
    const before = 'keep\n整段被引用的内容\nend';
    const anchor = {
      quote: '整段被引用的内容',
      index: before.indexOf('整段'),
      status: 'anchored' as const,
    };
    const r = resolveExcerpt(anchor, 'keep\nend');
    expect(r.status).toBe('lost');
    expect(r.content).toBe('整段被引用的内容');
  });
});

describe('reference dependency graph', () => {
  it('refuses a direct back-reference cycle', () => {
    const g = new ReferenceGraph();
    g.setEdges('A', ['B']);
    expect(g.wouldCycle('B', 'A')).toBe(true);
    expect(g.wouldCycle('C', 'A')).toBe(false);
  });

  it('refuses an indirect (transitive) cycle', () => {
    const g = new ReferenceGraph();
    g.setEdges('A', ['B']);
    g.setEdges('B', ['C']);
    expect(g.wouldCycle('C', 'A')).toBe(true);
    expect(g.wouldCycle('C', 'B')).toBe(true);
    expect(g.wouldCycle('D', 'A')).toBe(false);
  });

  it('re-evaluates after edges are removed', () => {
    const g = new ReferenceGraph();
    g.setEdges('A', ['B']);
    g.setEdges('B', ['C']);
    g.setEdges('B', []); // B no longer references C
    expect(g.wouldCycle('C', 'A')).toBe(false);
  });

  it('fans out to direct and transitive referrers only', () => {
    const g = new ReferenceGraph();
    g.setEdges('A', ['S']);
    g.setEdges('B', ['S']);
    g.setEdges('C', ['A']);
    g.setEdges('D', ['E']);
    expect(g.directReferrers('S').sort()).toEqual(['A', 'B']);
    expect(g.allReferrers('S').sort()).toEqual(['A', 'B', 'C']);
    expect(g.allReferrers('E')).toEqual(['D']);
  });
});

describe('markdown expansion', () => {
  const resolver =
    (map: Record<string, Partial<ResolvedRef>>) =>
    (id: string): ResolvedRef | undefined => {
      const r = map[id];
      if (!r) return undefined;
      return {
        excerptId: id,
        sourceDocId: 'src',
        sourceTitle: '源文档',
        status: 'anchored',
        content: '',
        allowed: true,
        ...r,
      };
    };

  it('splits local text around expanded reference blocks', () => {
    const blocks = expandMarkdown(
      `前文\n${refMarker('ex_1')}\n后文`,
      resolver({ ex_1: { content: '被引用的内容' } }),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: 'md', markdown: '前文\n' });
    expect(blocks[1].kind).toBe('ref');
    expect(blocks[2]).toEqual({ kind: 'md', markdown: '\n后文' });
  });

  it('expands nested references transitively', () => {
    const blocks = expandMarkdown(
      refMarker('ex_a'),
      resolver({
        ex_a: { content: `A 段 ${refMarker('ex_b')}` },
        ex_b: { content: 'B 段' },
      }),
    );
    const outer = blocks[0];
    expect(outer.kind).toBe('ref');
    if (outer.kind !== 'ref') return;
    expect(outer.blocks.some((b) => b.kind === 'ref')).toBe(true);
  });

  it('guards against expansion cycles instead of recursing forever', () => {
    const blocks = expandMarkdown(
      refMarker('ex_a'),
      resolver({
        ex_a: { content: `A ${refMarker('ex_b')}` },
        ex_b: { content: `B ${refMarker('ex_a')}` },
      }),
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('"cycleGuard":true');
  });

  it('never expands content for a forbidden reference', () => {
    const blocks = expandMarkdown(
      refMarker('ex_secret'),
      resolver({ ex_secret: { allowed: false, content: '', status: 'invalid' } }),
    );
    const outer = blocks[0];
    expect(outer.kind).toBe('ref');
    if (outer.kind !== 'ref') return;
    expect(outer.ref.allowed).toBe(false);
    expect(outer.blocks).toEqual([]);
  });

  it('renders unknown excerpt ids as invalid blocks without content', () => {
    const blocks = expandMarkdown(refMarker('ex_gone'), resolver({}));
    const outer = blocks[0];
    expect(outer.kind).toBe('ref');
    if (outer.kind !== 'ref') return;
    expect(outer.ref.status).toBe('invalid');
    expect(outer.ref.content).toBe('');
  });
});
