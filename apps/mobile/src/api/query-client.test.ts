import { createQueryClient } from './query-client';

describe('query client', () => {
  it('does not retry mutations, so a request is never sent twice by accident', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.mutations?.retry).toBe(0);
  });

  it('does not refetch on focus, which would spend the user data on every app switch', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('gives each client its own cache', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
