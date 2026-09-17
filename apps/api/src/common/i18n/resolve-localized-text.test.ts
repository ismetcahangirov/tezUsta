import { describe, expect, it } from 'vitest';

import type { LocalizedText } from './localized-text.types';
import { resolveLocalizedText } from './resolve-localized-text';

describe('resolveLocalizedText', () => {
  it('returns the first preference that has a translation', () => {
    const text: LocalizedText = { az: 'Santexnika', en: 'Plumbing', ru: 'Сантехника' };

    expect(resolveLocalizedText(text, ['en', 'az'])).toBe('Plumbing');
  });

  it('falls back to az when no preference matches a translation in the map', () => {
    const text: LocalizedText = { az: 'Santexnika', en: 'Plumbing' };

    expect(resolveLocalizedText(text, ['fr', 'de'])).toBe('Santexnika');
  });

  it('falls back to az when there are no preferences at all', () => {
    const text: LocalizedText = { az: 'Santexnika', en: 'Plumbing' };

    expect(resolveLocalizedText(text, [])).toBe('Santexnika');
  });

  it('skips a preference whose value is an empty or whitespace-only string', () => {
    const text: LocalizedText = { az: 'Santexnika', en: '   ', ru: 'Сантехника' };

    // 'en' is present as a key but carries no real content, so it must be
    // skipped in favour of the next preference rather than returned as-is.
    expect(resolveLocalizedText(text, ['en', 'ru'])).toBe('Сантехника');
  });

  it('falls further back to any non-empty value when az itself is empty', () => {
    // The database CHECK constraint `*_name_has_fallback` forbids this in
    // practice, but a value read back through JSON.parse cannot prove that —
    // this is the last-resort path documented on the function itself.
    const text: LocalizedText = { az: '   ', en: '', ru: 'Сантехника' };

    expect(resolveLocalizedText(text, ['fr'])).toBe('Сантехника');
  });

  it('returns an empty string, rather than throwing, when nothing in the map has content', () => {
    const text: LocalizedText = { az: '' };

    expect(resolveLocalizedText(text, ['en'])).toBe('');
  });

  it('does not mutate the input map', () => {
    const text: LocalizedText = { az: 'Santexnika', en: '   ' };
    const snapshot = { ...text };

    resolveLocalizedText(text, ['en']);

    expect(text).toEqual(snapshot);
  });
});
