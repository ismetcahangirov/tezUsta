import { describe, expect, it } from 'vitest';

import { isAzerbaijaniMobile, maskPhone, normaliseAzerbaijaniPhone } from './azerbaijani-phone';

const CANONICAL = '+994501234567';

describe('normaliseAzerbaijaniPhone', () => {
  describe('every form a person might actually type reaches one spelling', () => {
    // This is the property the whole module exists for. ADR-0008 requires
    // phone numbers to be "unique among verified users", and the partial
    // unique index in `users` can only deliver that if every write and every
    // lookup agrees on one string. Two spellings of one number means one
    // person can hold two master profiles and shed a poor rating by switching
    // between them.
    it.each([
      ['already canonical', CANONICAL],
      ['international with spaces', '+994 50 123 45 67'],
      ['international without the plus', '994501234567'],
      ['national trunk form', '0501234567'],
      ['bare national significant number', '501234567'],
      ['national with a bracketed area code', '(050) 123-45-67'],
      ['pasted with a non-breaking space', '+994 50 123 45 67'],
      ['pasted with a non-breaking hyphen', '+994‑50‑123‑45‑67'],
    ])('normalises %s to the canonical E.164 form', (_label, input) => {
      const result = normaliseAzerbaijaniPhone(input);

      expect(result).toEqual({ ok: true, e164: CANONICAL });
    });

    it('is idempotent — normalising its own output changes nothing', () => {
      const once = normaliseAzerbaijaniPhone('0501234567');
      expect(once.ok).toBe(true);
      if (!once.ok) return;

      expect(normaliseAzerbaijaniPhone(once.e164)).toEqual({ ok: true, e164: once.e164 });
    });
  });

  describe('numbers outside the Azerbaijani plan are rejected rather than guessed at', () => {
    it('rejects an empty string', () => {
      expect(normaliseAzerbaijaniPhone('')).toEqual({ ok: false, reason: 'empty' });
      expect(normaliseAzerbaijaniPhone('   ')).toEqual({ ok: false, reason: 'empty' });
    });

    it('reports a foreign number as not_azerbaijani, not as a length problem', () => {
      // A distinct reason because the two mean different things to the
      // business: a typo is a support issue, a foreign number is a signal that
      // somebody outside the launch market is trying to sign up.
      expect(normaliseAzerbaijaniPhone('+1 415 555 0123')).toEqual({
        ok: false,
        reason: 'not_azerbaijani',
      });
    });

    it.each([
      ['one digit short', '+99450123456'],
      ['one digit long', '+9945012345678'],
    ])('rejects %s', (_label, input) => {
      expect(normaliseAzerbaijaniPhone(input)).toEqual({ ok: false, reason: 'wrong_length' });
    });

    it('rejects a nine-digit number on a prefix the numbering plan does not assign', () => {
      // `30` is not in libphonenumber's AZ national pattern. Nine digits is
      // the right length, so only the pattern catches this.
      expect(normaliseAzerbaijaniPhone('+994301234567')).toEqual({
        ok: false,
        reason: 'not_a_valid_number',
      });
    });

    it('accepts the 365 branch of the national pattern, which is shorter than the others', () => {
      // `365\d{6}` is a separate alternative in the AZ metadata; a naive
      // "two-digit prefix plus seven" rule would reject it.
      expect(normaliseAzerbaijaniPhone('+994365123456')).toEqual({
        ok: true,
        e164: '+994365123456',
      });
    });

    it('rejects a string with no digits at all', () => {
      expect(normaliseAzerbaijaniPhone('not a phone number')).toEqual({
        ok: false,
        reason: 'empty',
      });
    });
  });
});

describe('isAzerbaijaniMobile', () => {
  it.each(['+994101234567', '+994501234567', '+994551234567', '+994701234567', '+994991234567'])(
    'recognises %s as a mobile number',
    (e164) => {
      expect(isAzerbaijaniMobile(e164)).toBe(true);
    },
  );

  it('does not treat a Baku landline as a mobile', () => {
    // `AZ_NATIONAL` accepts it as a valid number — this is the separate
    // question of whether an SMS could ever arrive.
    expect(normaliseAzerbaijaniPhone('+994121234567').ok).toBe(true);
    expect(isAzerbaijaniMobile('+994121234567')).toBe(false);
  });
});

describe('maskPhone', () => {
  it('leaves only the last two digits visible', () => {
    expect(maskPhone(CANONICAL)).toBe('+994*******67');
  });

  it('never contains the full number, which is what security.md forbids logging', () => {
    const masked = maskPhone(CANONICAL);

    expect(masked).not.toContain('501234567');
    expect(masked).not.toContain(CANONICAL);
    // Enough for someone holding the handset to recognise their own number in
    // a support call, and far too little to identify anyone from a log.
    expect(masked.endsWith('67')).toBe(true);
  });
});
