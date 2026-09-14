import { render, screen } from '@testing-library/react-native';

import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('falls back to initials when there is no photo', async () => {
    await render(<Avatar name="Elvin Məmmədov" />);

    expect(screen.getByText('EM')).toBeOnTheScreen();
  });

  it('upper-cases Azerbaijani initials correctly', async () => {
    // Azerbaijani maps "i" to "İ", not to "I".
    await render(<Avatar name="ismət cahangirov" />);

    expect(screen.getByText('İC')).toBeOnTheScreen();
  });

  it('handles a single-word name', async () => {
    await render(<Avatar name="Aygün" />);

    expect(screen.getByText('A')).toBeOnTheScreen();
  });

  it('is labelled with the person it represents', async () => {
    await render(<Avatar name="Elvin Məmmədov" uri="https://example.test/a.png" />);

    expect(screen.getByLabelText('Elvin Məmmədov')).toBeOnTheScreen();
  });
});
