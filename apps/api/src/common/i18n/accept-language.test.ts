import { describe, expect, it } from 'vitest';

import { parseAcceptLanguage } from './accept-language';

describe('parseAcceptLanguage', () => {
  it('returns no preferences for an absent header', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });

  it('returns no preferences for an empty header', () => {
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('returns no preferences for a whitespace-only header', () => {
    expect(parseAcceptLanguage('   ')).toEqual([]);
  });

  it('parses a single bare tag', () => {
    expect(parseAcceptLanguage('az')).toEqual(['az']);
  });

  it('orders preferences by descending q, treating an absent q as 1', () => {
    expect(parseAcceptLanguage('ru,az;q=0.9,en;q=0.8')).toEqual(['ru', 'az', 'en']);
  });

  it('keeps first-seen order for equal q values rather than letting a sort reorder them', () => {
    // All three share the implicit q=1 — nothing here distinguishes them
    // except the order they were sent in, which must survive untouched.
    expect(parseAcceptLanguage('en,ru,az')).toEqual(['en', 'ru', 'az']);
    // Same property with explicit, equal q values.
    expect(parseAcceptLanguage('en;q=0.5,ru;q=0.5,az;q=0.5')).toEqual(['en', 'ru', 'az']);
  });

  it('drops a tag whose q is explicitly 0, because that means "not acceptable"', () => {
    expect(parseAcceptLanguage('en;q=0,az')).toEqual(['az']);
  });

  it('drops the wildcard, which tells a fallback resolver nothing', () => {
    expect(parseAcceptLanguage('*,az')).toEqual(['az']);
  });

  it('drops a wildcard even when it carries an explicit q', () => {
    expect(parseAcceptLanguage('*;q=0.9,az;q=0.5')).toEqual(['az']);
  });

  it('collapses a duplicate primary subtag, keeping the higher-preference occurrence', () => {
    // en-GB carries the implicit q=1 and arrives first; en;q=0.5 is the same
    // primary subtag at lower preference, so only 'en' survives, once.
    expect(parseAcceptLanguage('en-GB,en;q=0.5')).toEqual(['en']);
  });

  it('collapses a duplicate primary subtag the other way round, by q rather than by order', () => {
    // Here the lower-preference spelling is sent first; the higher q must
    // still win even though it arrives second.
    expect(parseAcceptLanguage('en;q=0.5,en-GB')).toEqual(['en']);
  });

  it.each([
    ['a non-numeric q', 'az;q=abc'],
    ['an empty segment with no tag', ';;'],
    ['a q with no value after the equals sign', 'az;q='],
  ])('skips a malformed segment (%s) rather than throwing', (_label, header) => {
    expect(() => parseAcceptLanguage(header)).not.toThrow();
    expect(parseAcceptLanguage(header)).toEqual([]);
  });

  it.each([
    ['above 1', 'az;q=1.5'],
    ['negative', 'az;q=-0.1'],
  ])('treats a q value %s as malformed and drops the segment', (_label, header) => {
    expect(parseAcceptLanguage(header)).toEqual([]);
  });

  it('recovers the remaining valid segments around a malformed one', () => {
    expect(parseAcceptLanguage('ru,az;q=abc,en;q=0.5')).toEqual(['ru', 'en']);
  });

  it('caps the number of parsed segments and ignores the rest', () => {
    // 25 distinct two-letter primary subtags (aa, ab, ac, … valid under
    // TAG_PATTERN, which allows letters only); only the first 20 should
    // survive. Each tag is a distinct primary subtag so truncation, not
    // de-duplication, is what is under test.
    const letter = (n: number) => String.fromCharCode(97 + n);
    const tags = Array.from({ length: 25 }, (_unused, i) => `a${letter(i % 26)}`);
    const header = tags.join(',');

    const result = parseAcceptLanguage(header);

    expect(result).toHaveLength(20);
    expect(result).toEqual(tags.slice(0, 20));
  });

  it('skips a tag longer than the 35-character practical BCP 47 cap', () => {
    const tooLong = 'a'.repeat(36);
    expect(parseAcceptLanguage(`${tooLong},az`)).toEqual(['az']);
  });

  it('accepts a tag right at the 35-character cap', () => {
    // 'aa' (2) + '-bbbbbbbb' (9) + '-cccccccc' (9) + '-dddddddd' (9) +
    // '-eeeee' (6) = 35, with every subtag within the 2-8 char subtag limit.
    const atCap = ['aa', 'b'.repeat(8), 'c'.repeat(8), 'd'.repeat(8), 'e'.repeat(5)].join('-');
    expect(atCap).toHaveLength(35);
    expect(parseAcceptLanguage(atCap)).toEqual(['aa']);
  });

  it.each([
    ['digits', '994'],
    ['a lone hyphen', '-'],
    ['a single letter', 'a'],
  ])('skips a tag that does not match the BCP 47 shape (%s)', (_label, header) => {
    expect(parseAcceptLanguage(header)).toEqual([]);
  });

  it('lowercases a region-qualified tag down to its primary subtag', () => {
    expect(parseAcceptLanguage('EN-GB')).toEqual(['en']);
  });

  it('trims stray whitespace around tags and parameters', () => {
    expect(parseAcceptLanguage(' ru , az ; q=0.9 , en ; q=0.8 ')).toEqual(['ru', 'az', 'en']);
  });
});
