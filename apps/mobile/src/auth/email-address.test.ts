import { isPlausibleEmail, MAX_EMAIL_LENGTH, normaliseEmail } from './email-address';

describe('normaliseEmail', () => {
  it('trims and lowercases, as the server does', () => {
    expect(normaliseEmail('  Aysel.Mammadova@Example.AZ \n')).toBe('aysel.mammadova@example.az');
  });
});

describe('isPlausibleEmail', () => {
  it.each(['ali@example.az', 'a.b+tezusta@mail.example.com', 'x@y.co'])('accepts %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(true);
  });

  it.each([
    ['nothing at all', ''],
    ['no @', 'ali.example.az'],
    ['no domain', 'ali@'],
    ['no local part', '@example.az'],
    ['no dot in the domain', 'ali@example'],
    ['a space inside', 'ali veli@example.az'],
    ['two @', 'ali@veli@example.az'],
    ['a phone number', '+994501234567'],
  ])('refuses %s', (_case, email) => {
    expect(isPlausibleEmail(email)).toBe(false);
  });

  it('refuses an address longer than the server accepts', () => {
    const domain = '@example.az';
    const atLimit = `${'a'.repeat(MAX_EMAIL_LENGTH - domain.length)}${domain}`;

    expect(isPlausibleEmail(atLimit)).toBe(true);
    expect(isPlausibleEmail(`a${atLimit}`)).toBe(false);
  });
});
