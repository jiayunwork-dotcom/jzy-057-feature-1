import { describe, expect, it } from 'vitest';
import { documentGraph, wouldCreateCycle, type DepEdge } from '../src/reference/graph.js';

describe('reference dependency graph', () => {
  const edges: DepEdge[] = [
    { refDocId: 'B', sourceDocId: 'A' }, // B -> A
    { refDocId: 'C', sourceDocId: 'A' }, // C -> A
    { refDocId: 'D', sourceDocId: 'B' }, // D -> B
  ];

  it('builds unique document-level edges', () => {
    const g = documentGraph([
      ...edges,
      { refDocId: 'B', sourceDocId: 'A' }, // duplicate per different snippet
    ]);
    expect(g.get('B')).toEqual(new Set(['A']));
    expect(g.get('D')).toEqual(new Set(['B']));
  });

  it('accepts edges that keep the graph acyclic', () => {
    expect(wouldCreateCycle(edges, 'E', 'A')).toBe(false);
    expect(wouldCreateCycle(edges, 'A', 'E')).toBe(false);
    expect(wouldCreateCycle(edges, 'E', 'D')).toBe(false);
  });

  it('rejects a direct self reference', () => {
    expect(wouldCreateCycle(edges, 'A', 'A')).toBe(true);
  });

  it('rejects an edge closing an indirect cycle back to the source', () => {
    // A would embed content from D; D -> B -> A already exists, so this closes
    // the A -> D -> B -> A loop.
    expect(wouldCreateCycle(edges, 'A', 'D')).toBe(true);
    // B -> C is fine (C has no outgoing path back to B).
    expect(wouldCreateCycle(edges, 'B', 'C')).toBe(false);
  });

  it('detects a longer ring (A->B->C->A)', () => {
    const ring: DepEdge[] = [
      { refDocId: 'B', sourceDocId: 'A' },
      { refDocId: 'C', sourceDocId: 'B' },
    ];
    expect(wouldCreateCycle(ring, 'A', 'C')).toBe(true);
  });
});
