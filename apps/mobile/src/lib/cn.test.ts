import { cn } from './cn';

describe('cn', () => {
  it('joins the class names it is given', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops values that are not class names', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('keeps caller overrides last so they win', () => {
    expect(cn('bg-surface', 'bg-accent')).toBe('bg-surface bg-accent');
  });
});
