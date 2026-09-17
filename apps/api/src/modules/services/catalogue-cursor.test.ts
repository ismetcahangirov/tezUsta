import { describe, expect, it } from 'vitest';

import { decodeCatalogueCursor, encodeCatalogueCursor } from './catalogue-cursor';

const A_POSITION = { displayOrder: 7, id: '01900000-0000-7000-8000-000000000001' };

describe('the catalogue cursor', () => {
  it('round-trips the position it was given', () => {
    expect(decodeCatalogueCursor(encodeCatalogueCursor(A_POSITION))).toEqual(A_POSITION);
  });

  it('survives a display order of zero, which is the default every row starts at', () => {
    const position = { displayOrder: 0, id: A_POSITION.id };
    expect(decodeCatalogueCursor(encodeCatalogueCursor(position))).toEqual(position);
  });

  it('encodes to something URL-safe, since it travels in a query string', () => {
    const cursor = encodeCatalogueCursor(A_POSITION);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('reads an absent cursor as "start from the beginning"', () => {
    expect(decodeCatalogueCursor(undefined)).toBeNull();
    expect(decodeCatalogueCursor('')).toBeNull();
  });

  it('refuses a cursor that is not base64 at all, rather than throwing', () => {
    expect(decodeCatalogueCursor('not a cursor!!')).toBeNull();
  });

  it('refuses base64 that does not decode to JSON', () => {
    expect(decodeCatalogueCursor(Buffer.from('nonsense', 'utf8').toString('base64url'))).toBeNull();
  });

  it('refuses JSON of the wrong shape', () => {
    const wrongShape = Buffer.from(JSON.stringify({ o: 'seven', i: 12 }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCatalogueCursor(wrongShape)).toBeNull();
  });

  it('refuses an id that is not a UUID, so a cursor cannot smuggle a value into a query', () => {
    const injected = Buffer.from(JSON.stringify({ o: 1, i: "' OR 1=1 --" }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCatalogueCursor(injected)).toBeNull();
  });

  it('refuses a fractional display order, which no row can have', () => {
    const fractional = Buffer.from(JSON.stringify({ o: 1.5, i: A_POSITION.id }), 'utf8').toString(
      'base64url',
    );
    expect(decodeCatalogueCursor(fractional)).toBeNull();
  });

  it('round-trips the largest display order the int4 column can hold', () => {
    const position = { displayOrder: 2147483647, id: A_POSITION.id };
    expect(decodeCatalogueCursor(encodeCatalogueCursor(position))).toEqual(position);
  });

  it('round-trips the smallest display order the int4 column can hold', () => {
    const position = { displayOrder: -2147483648, id: A_POSITION.id };
    expect(decodeCatalogueCursor(encodeCatalogueCursor(position))).toEqual(position);
  });

  it('decodes to null, rather than 500ing Postgres, one past the int4 maximum', () => {
    const tooHigh = Buffer.from(
      JSON.stringify({ o: 2147483648, i: A_POSITION.id }),
      'utf8',
    ).toString('base64url');
    expect(decodeCatalogueCursor(tooHigh)).toBeNull();
  });

  it('decodes to null, rather than 500ing Postgres, one past the int4 minimum', () => {
    const tooLow = Buffer.from(
      JSON.stringify({ o: -2147483649, i: A_POSITION.id }),
      'utf8',
    ).toString('base64url');
    expect(decodeCatalogueCursor(tooLow)).toBeNull();
  });
});
