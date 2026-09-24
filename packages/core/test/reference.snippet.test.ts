import { describe, expect, it } from 'vitest';
import { resolveSnippet, type SnippetAnchor } from '../src/reference/snippet.js';

const anchored = (quote: string, index: number): SnippetAnchor => ({
  quote,
  index,
  status: 'anchored',
});

describe('snippet anchoring', () => {
  it('returns the verbatim current content after edits and follows position', () => {
    const before = '# API\n前置条件：Node 20\n## 接口\n';
    const s = anchored('前置条件：Node 20', before.indexOf('前置条件'));
    const after = '# API\n更多说明\n前置条件：Node 20\n## 接口\n';
    const r = resolveSnippet(s, after);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe('前置条件：Node 20');
    expect(after.slice(r.index, r.end)).toBe('前置条件：Node 20');
  });

  it('does not drift when a large block is inserted before the snippet', () => {
    const before = 'KEEP_ME\ntail';
    const s = anchored('KEEP_ME', 0);
    const prefix = 'X'.repeat(500) + '\n';
    const r = resolveSnippet(s, prefix + before);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe('KEEP_ME');
    expect(r.index).toBe(prefix.length);
  });

  it('tracks a partial rewrite and adopts the new wording verbatim', () => {
    // A version-bump rewrite (one char replaced at the end) must follow the
    // same-length window rather than shrinking onto a shorter prefix — the
    // adopted text is what every referencing document renders.
    const s = anchored('前置条件: Node 20', 0);
    const after = '前置条件: Node 24';
    const r = resolveSnippet(s, after);
    expect(r.status).toBe('anchored');
    expect(r.content).toBe('前置条件: Node 24');
    // The adopted quote now resolves exactly on the next pass, even if moved.
    const again = resolveSnippet(r, '说明\n前置条件: Node 24\n');
    expect(again.content).toBe('前置条件: Node 24');
  });

  it('goes lost with last content retained when the snippet is deleted wholesale', () => {
    const s = anchored('delete this block', 0);
    const r = resolveSnippet(s, 'unrelated remaining text');
    expect(r.status).toBe('lost');
    expect(r.quote).toBe('delete this block');
    expect(r.content).toBe('delete this block');
  });

  it('re-resolves after the content reappears', () => {
    const s = anchored('NEEDLE', 0);
    const lost = resolveSnippet(s, 'hay only');
    expect(lost.status).toBe('lost');
    const found = resolveSnippet(lost, 'hay NEEDLE');
    expect(found.status).toBe('anchored');
    expect(found.content).toBe('NEEDLE');
  });
});
