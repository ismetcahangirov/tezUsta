import { describe, expect, it } from 'vitest';

import { InvalidPublicKeyError, buildPublicUrl } from './public-url';

describe('buildPublicUrl (issue #304)', () => {
  it('joins the base and the key with one slash, whether or not the base ends in one', () => {
    expect(buildPublicUrl('https://media.example.com', 'portfolio/abc/thumb.webp')).toBe(
      'https://media.example.com/portfolio/abc/thumb.webp',
    );
    expect(buildPublicUrl('https://media.example.com/', 'portfolio/abc/thumb.webp')).toBe(
      'https://media.example.com/portfolio/abc/thumb.webp',
    );
  });

  it('keeps a path on the base, for a domain that serves media under one', () => {
    expect(buildPublicUrl('https://cdn.example.com/media/', 'avatars/x/display.webp')).toBe(
      'https://cdn.example.com/media/avatars/x/display.webp',
    );
  });

  it('percent-encodes each segment and keeps the slashes between them', () => {
    expect(buildPublicUrl('https://media.example.com', 'a b/c?d#e/f.webp')).toBe(
      'https://media.example.com/a%20b/c%3Fd%23e/f.webp',
    );
  });

  it.each([
    ['an empty key', ''],
    ['a leading slash', '/portfolio/x.webp'],
    ['an empty segment', 'portfolio//x.webp'],
    ['a trailing slash', 'portfolio/'],
    ['a dot segment', 'portfolio/./x.webp'],
    ['a dot-dot segment', 'portfolio/../private/x'],
  ])('refuses %s, which a CDN would normalise to another path', (_label, key) => {
    expect(() => buildPublicUrl('https://media.example.com', key)).toThrow(InvalidPublicKeyError);
  });
});
