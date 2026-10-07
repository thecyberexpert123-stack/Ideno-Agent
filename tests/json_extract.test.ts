import { describe, expect, it } from 'vitest';

import { balancedCandidates, extractJson, stripTrailingCommas } from '../src/ai/runtime/json_extract.js';

describe('extractJson', () => {
  it('accepts a response that is already JSON', () => {
    const result = extractJson('{"a":1}');
    expect(result.strategy).toBe('direct');
    expect(result.json).toEqual({ a: 1 });
  });

  it('accepts JSON inside a fenced block', () => {
    const result = extractJson('Here you go:\n```json\n{"a":[1,2]}\n```\nLet me know.');
    expect(result.strategy).toBe('fenced');
    expect(result.json).toEqual({ a: [1, 2] });
  });

  it('accepts a fence with no language tag', () => {
    const result = extractJson('```\n{"a":true}\n```');
    expect(result.strategy).toBe('fenced');
    expect(result.json).toEqual({ a: true });
  });

  it('accepts an unterminated fence from a truncated response', () => {
    const result = extractJson('```json\n{"a":1}');
    expect(result.strategy).toBe('fenced');
    expect(result.json).toEqual({ a: 1 });
  });

  it('finds JSON embedded in prose', () => {
    const result = extractJson('Sure — the update is {"changes":{"title":"Pump"}} as requested.');
    expect(result.strategy).toBe('balanced');
    expect(result.json).toEqual({ changes: { title: 'Pump' } });
  });

  it('prefers the largest balanced value, not the first', () => {
    const result = extractJson('Note {important}: {"a":{"b":[1,2,3]}}');
    expect(result.json).toEqual({ a: { b: [1, 2, 3] } });
  });

  it('is not confused by braces inside strings', () => {
    const result = extractJson('{"text":"a } b { c","other":1}');
    expect(result.json).toEqual({ text: 'a } b { c', other: 1 });
  });

  it('is not confused by escaped quotes inside strings', () => {
    const result = extractJson('{"text":"she said \\"hi\\"","n":2}');
    expect(result.json).toEqual({ text: 'she said "hi"', n: 2 });
  });

  it('repairs a trailing comma, the most common model mistake', () => {
    const result = extractJson('{"a":1,"b":[2,3,],}');
    expect(result.strategy).toBe('repaired');
    expect(result.json).toEqual({ a: 1, b: [2, 3] });
  });

  it('accepts a top-level array', () => {
    expect(extractJson('[{"a":1},{"b":2}]').json).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports an empty response as empty, not as malformed', () => {
    const result = extractJson('   \n ');
    expect(result.strategy).toBe('none');
    expect(result.error).toMatch(/empty response/);
  });

  it('reports prose with no JSON, with an excerpt for diagnosis', () => {
    const result = extractJson('I would be happy to help you plan your greenhouse!');
    expect(result.strategy).toBe('none');
    expect(result.error).toMatch(/No parseable JSON/);
    expect(result.error).toMatch(/greenhouse/);
  });

  it('truncates a long excerpt instead of echoing the whole response', () => {
    const result = extractJson(`${'word '.repeat(500)} and no json`);
    expect(result.strategy).toBe('none');
    expect((result.error ?? '').length).toBeLessThan(400);
  });
});

describe('balancedCandidates', () => {
  it('returns every top-level value in document order', () => {
    expect(balancedCandidates('a {"x":1} b [2] c')).toEqual(['{"x":1}', '[2]']);
  });

  it('keeps scanning inside a span swallowed by a stray brace', () => {
    const candidates = balancedCandidates('Note {unbalanced and then {"real":true}');
    expect(candidates).toContain('{"real":true}');
    // ...and extractJson still finds the payload despite the stray brace.
    expect(extractJson('Note {unbalanced and then {"real":true}').json).toEqual({ real: true });
  });

  it('finds nested objects as candidates too', () => {
    expect(balancedCandidates('{"a":{"b":1}}')).toEqual(['{"a":{"b":1}}', '{"b":1}']);
  });

  it('returns nothing for text with no brackets', () => {
    expect(balancedCandidates('just prose')).toEqual([]);
  });
});

describe('stripTrailingCommas', () => {
  it('removes commas before closing brackets', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]');
  });

  it('leaves commas inside strings alone', () => {
    expect(stripTrailingCommas('{"a":"x,}y"}')).toBe('{"a":"x,}y"}');
  });

  it('leaves legitimate commas alone', () => {
    expect(stripTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });
});
