import { describe, expect, test } from 'bun:test';
import {
  collectAssistantText,
  extractJSONArray,
  extractJSONObject,
  formatTemplate,
} from '../../src/domain/llm';

describe('formatTemplate', () => {
  test('replaces %s placeholders in order', () => {
    expect(formatTemplate('Hello %s, you are %s', ['world', 'great'])).toBe(
      'Hello world, you are great',
    );
  });

  test('leaves extra %s when not enough values', () => {
    expect(formatTemplate('%s and %s', ['only'])).toBe('only and %s');
  });

  test('ignores extra values', () => {
    expect(formatTemplate('just %s', ['one', 'two'])).toBe('just one');
  });

  test('handles empty template', () => {
    expect(formatTemplate('', ['x'])).toBe('');
  });
});

describe('collectAssistantText', () => {
  test('joins text events', () => {
    const events = [
      { type: 'text' as const, text: 'Hello ' },
      { type: 'tool_call' as const },
      { type: 'text' as const, text: 'world' },
    ];
    expect(collectAssistantText(events as any)).toBe('Hello world');
  });

  test('returns empty string for no text events', () => {
    expect(collectAssistantText([{ type: 'tool_call' as const } as any])).toBe(
      '',
    );
  });

  test('trims result', () => {
    const events = [{ type: 'text' as const, text: '  trimmed  ' }];
    expect(collectAssistantText(events as any)).toBe('trimmed');
  });
});

describe('extractJSONObject', () => {
  test('extracts from raw JSON', () => {
    const result = extractJSONObject<{ name: string }>('{"name": "test"}');
    expect(result).toEqual({ name: 'test' });
  });

  test('extracts from fenced code block', () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    const result = extractJSONObject<{ key: string }>(text);
    expect(result).toEqual({ key: 'value' });
  });

  test('extracts from mixed text', () => {
    const text = 'The output is {"count": 42} and some more text';
    const result = extractJSONObject<{ count: number }>(text);
    expect(result).toEqual({ count: 42 });
  });

  test('camelizes snake_case keys', () => {
    const result = extractJSONObject<{ myKey: string }>('{"my_key": "hello"}');
    expect(result).toEqual({ myKey: 'hello' });
  });

  test('returns null for no JSON', () => {
    expect(extractJSONObject('no json here')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractJSONObject('')).toBeNull();
  });

  test('rejects arrays', () => {
    expect(extractJSONObject('[1, 2, 3]')).toBeNull();
  });

  test('handles nested objects', () => {
    const text = '{"outer": {"inner_key": "val"}}';
    const result = extractJSONObject<{ outer: { innerKey: string } }>(text);
    expect(result).toEqual({ outer: { innerKey: 'val' } });
  });
});

describe('extractJSONArray', () => {
  test('extracts from raw JSON array', () => {
    const result = extractJSONArray<number>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  test('extracts from fenced block', () => {
    const text = '```json\n[{"title": "task"}]\n```';
    const result = extractJSONArray<{ title: string }>(text);
    expect(result).toEqual([{ title: 'task' }]);
  });

  test('camelizes array element keys', () => {
    const result = extractJSONArray<{ myField: number }>('[{"my_field": 1}]');
    expect(result).toEqual([{ myField: 1 }]);
  });

  test('returns null for no array', () => {
    expect(extractJSONArray('just text')).toBeNull();
  });

  test('returns null for object', () => {
    expect(extractJSONArray('{"not": "array"}')).toBeNull();
  });

  test('handles embedded JSON in prose', () => {
    const text =
      'I suggest these tasks:\n[{"title": "A"}, {"title": "B"}]\nLet me know.';
    const result = extractJSONArray<{ title: string }>(text);
    expect(result).toEqual([{ title: 'A' }, { title: 'B' }]);
  });
});
