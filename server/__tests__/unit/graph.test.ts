import { describe, expect, test } from 'bun:test';
import { detectCycle, topoSort } from '../../src/store/graph';

describe('detectCycle', () => {
  test('returns null for empty graph', () => {
    expect(detectCycle([], () => [])).toBeNull();
  });

  test('returns null for independent nodes', () => {
    expect(detectCycle(['a', 'b', 'c'], () => [])).toBeNull();
  });

  test('returns null for linear chain', () => {
    const deps: Record<string, string[]> = { a: [], b: ['a'], c: ['b'] };
    expect(detectCycle(['a', 'b', 'c'], (id) => deps[id] ?? [])).toBeNull();
  });

  test('detects self-cycle', () => {
    const cycle = detectCycle(['a'], (id) => (id === 'a' ? ['a'] : []));
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('a');
  });

  test('detects two-node cycle', () => {
    const deps: Record<string, string[]> = { a: ['b'], b: ['a'] };
    const cycle = detectCycle(['a', 'b'], (id) => deps[id] ?? []);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  test('detects three-node cycle', () => {
    const deps: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['a'] };
    const cycle = detectCycle(['a', 'b', 'c'], (id) => deps[id] ?? []);
    expect(cycle).not.toBeNull();
  });

  test('ignores deps outside graph', () => {
    expect(detectCycle(['a'], (id) => (id === 'a' ? ['x'] : []))).toBeNull();
  });

  test('detects cycle in subgraph with acyclic nodes', () => {
    const deps: Record<string, string[]> = {
      a: [],
      b: ['c'],
      c: ['d'],
      d: ['b'],
    };
    const cycle = detectCycle(['a', 'b', 'c', 'd'], (id) => deps[id] ?? []);
    expect(cycle).not.toBeNull();
  });
});

describe('topoSort', () => {
  test('empty input', () => {
    expect(topoSort([], () => [])).toEqual([]);
  });

  test('single node', () => {
    expect(topoSort(['a'], () => [])).toEqual(['a']);
  });

  test('independent nodes preserve input order', () => {
    expect(topoSort(['b', 'a', 'c'], () => [])).toEqual(['b', 'a', 'c']);
  });

  test('linear chain orders deps first', () => {
    const deps: Record<string, string[]> = { a: [], b: ['a'], c: ['b'] };
    const result = topoSort(['c', 'b', 'a'], (id) => deps[id] ?? []);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'));
  });

  test('diamond dependency', () => {
    const deps: Record<string, string[]> = {
      a: [],
      b: ['a'],
      c: ['a'],
      d: ['b', 'c'],
    };
    const result = topoSort(['d', 'c', 'b', 'a'], (id) => deps[id] ?? []);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('c'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('d'));
    expect(result.indexOf('c')).toBeLessThan(result.indexOf('d'));
  });

  test('ignores deps outside input set', () => {
    const deps: Record<string, string[]> = { a: ['x'], b: ['a'] };
    const result = topoSort(['b', 'a'], (id) => deps[id] ?? []);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
  });
});
