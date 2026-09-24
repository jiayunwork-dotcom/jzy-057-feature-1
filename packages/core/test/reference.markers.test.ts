import { describe, expect, it } from 'vitest';
import {
  buildMarkerInsertion,
  findMarkers,
  markerLine,
  parseMarkerLine,
  referencedSnippetIds,
} from '../src/reference/markers.js';

describe('reference markers', () => {
  it('parses a canonical one-line marker and rejects ordinary lines', () => {
    expect(parseMarkerLine('^ref[sfr_abc#ref_xyz]')).toEqual({
      snippetId: 'sfr_abc',
      blockId: 'ref_xyz',
    });
    expect(parseMarkerLine('  ^ref[sfr_a#ref_b]  ')).toEqual({
      snippetId: 'sfr_a',
      blockId: 'ref_b',
    });
    expect(parseMarkerLine('x ^ref[sfr_a#ref_b]')).toBeNull();
    expect(parseMarkerLine('^ref[sfr_a#ref_b] trailing')).toBeNull();
    expect(parseMarkerLine('ordinary text')).toBeNull();
  });

  it('enumerates markers with line-accurate ranges inside multiline text', () => {
    const text = 'intro\n^ref[sfr_1#ref_1]\nbody\n^ref[sfr_2#ref_2]\n';
    const markers = findMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers[0].snippetId).toBe('sfr_1');
    expect(text.slice(markers[0].index, markers[0].end)).toBe('^ref[sfr_1#ref_1]\n');
    expect(text.slice(markers[1].index, markers[1].end)).toBe('^ref[sfr_2#ref_2]\n');
    expect(referencedSnippetIds(text)).toEqual(['sfr_1', 'sfr_2']);
  });

  it('dedupes the same snippet referenced twice in one document', () => {
    const text = `${markerLine('sfr_9', 'ref_a')}\n${markerLine('sfr_9', 'ref_b')}\n`;
    expect(referencedSnippetIds(text)).toEqual(['sfr_9']);
    expect(findMarkers(text).map((m) => m.blockId)).toEqual(['ref_a', 'ref_b']);
  });

  it('inserts a marker on its own line mid-text', () => {
    const text = 'abcdef';
    const edit = buildMarkerInsertion(text, 3, 'sfr_1', 'ref_1');
    const next =
      text.slice(0, edit.index) + edit.inserted + text.slice(edit.index + edit.delCount);
    expect(next).toBe('abc\n^ref[sfr_1#ref_1]\ndef');
    expect(findMarkers(next)).toHaveLength(1);
  });

  it('does not add blank splits at line start / line end', () => {
    expect(buildMarkerInsertion('abc', 0, 's', 'r').inserted).toBe('^ref[s#r]\n');
    expect(buildMarkerInsertion('abc\n', 4, 's', 'r').inserted).toBe('^ref[s#r]');
  });
});
