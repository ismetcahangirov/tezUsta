import { render, screen } from '@testing-library/react-native';

import { UnreadBadge } from './UnreadBadge';

describe('UnreadBadge', () => {
  it('shows the count and says what it counts', async () => {
    await render(<UnreadBadge count={3} accessibilityLabel="3 oxunmamış mesaj" />);

    expect(screen.getByText('3')).toBeOnTheScreen();
    expect(screen.getByLabelText('3 oxunmamış mesaj')).toBeOnTheScreen();
  });

  it('is absent when nothing is unread', async () => {
    await render(<UnreadBadge count={0} accessibilityLabel="0 oxunmamış mesaj" />);

    expect(screen.queryByLabelText('0 oxunmamış mesaj')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('caps a large count', async () => {
    await render(<UnreadBadge count={250} accessibilityLabel="250 oxunmamış mesaj" />);

    expect(screen.getByText('99+')).toBeOnTheScreen();
  });
});
