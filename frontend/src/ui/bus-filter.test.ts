// Unit tests for the pure bus-filter helpers (suggestion capping + resolution).
// bus-filter.ts value-imports the buses layer, which value-imports maplibre-gl
// (Popup), so we stub that module to keep the test in the fast node
// environment — same pattern as emergency-classify.test.ts.
import { describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { MAX_SUGGESTIONS, resolveLine, suggestLines } = await import('./bus-filter');

describe('suggestLines', () => {
  test('returns prefix matches before substring matches', () => {
    // Arrange
    const lines = ['124', '24', '241', '624', '99'];

    // Act
    const result = suggestLines(lines, '24');

    // Assert — '24' and '241' start with the query; '124'/'624' only contain it
    expect(result).toEqual(['24', '241', '124', '624']);
  });

  test('caps results at MAX_SUGGESTIONS', () => {
    // Arrange — 30 routes all sharing the '1' prefix
    const lines = Array.from({ length: 30 }, (_, i) => `1${i}`);

    // Act
    const result = suggestLines(lines, '1');

    // Assert
    expect(MAX_SUGGESTIONS).toBe(12);
    expect(result).toHaveLength(MAX_SUGGESTIONS);
    expect(result.every((line) => line.startsWith('1'))).toBe(true);
  });

  test('substring matches only fill slots left over after prefix matches', () => {
    // Arrange — 12 prefix hits already saturate the cap; '624' must not appear
    const prefixHits = Array.from({ length: 12 }, (_, i) => `24${i}`);
    const lines = ['624', ...prefixHits];

    // Act
    const result = suggestLines(lines, '24');

    // Assert
    expect(result).toHaveLength(MAX_SUGGESTIONS);
    expect(result).not.toContain('624');
  });

  test('matches case-insensitively and keeps canonical casing in results', () => {
    // Arrange — real mixed-case BODS line names
    const lines = ['Go2', 'x80', 'N25', 'W7'];

    // Act / Assert
    expect(suggestLines(lines, 'go')).toEqual(['Go2']);
    expect(suggestLines(lines, 'X8')).toEqual(['x80']);
    expect(suggestLines(lines, 'n25')).toEqual(['N25']);
  });

  test('returns no suggestions for empty or whitespace-only input', () => {
    // Arrange
    const lines = ['24', 'N25', 'Go2'];

    // Act / Assert
    expect(suggestLines(lines, '')).toEqual([]);
    expect(suggestLines(lines, '   ')).toEqual([]);
  });

  test('respects a custom cap', () => {
    // Arrange
    const lines = ['10', '11', '12', '13'];

    // Act
    const result = suggestLines(lines, '1', 2);

    // Assert
    expect(result).toEqual(['10', '11']);
  });
});

describe('resolveLine', () => {
  test('returns the canonical casing of a live line', () => {
    // Arrange
    const lines = ['Go2', 'x80', 'N25'];

    // Act / Assert
    expect(resolveLine('GO2', lines)).toBe('Go2');
    expect(resolveLine('X80', lines)).toBe('x80');
    expect(resolveLine('n25', lines)).toBe('N25');
  });

  test('passes an unknown line through uppercased', () => {
    // Arrange — 'w7' is not live right now
    const lines = ['24', 'Go2'];

    // Act / Assert
    expect(resolveLine('w7', lines)).toBe('W7');
  });

  test('trims surrounding whitespace before resolving', () => {
    // Arrange
    const lines = ['Go2'];

    // Act / Assert
    expect(resolveLine('  go2  ', lines)).toBe('Go2');
    expect(resolveLine('  24 ', [])).toBe('24');
  });

  test('resolves empty or whitespace-only input to the empty string', () => {
    // Act / Assert
    expect(resolveLine('', ['24'])).toBe('');
    expect(resolveLine('   ', ['24'])).toBe('');
  });
});
