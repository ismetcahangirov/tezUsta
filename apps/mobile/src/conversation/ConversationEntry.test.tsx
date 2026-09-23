import { fireEvent, render, screen } from '@testing-library/react-native';

import { CONVERSATION_COPY as copy } from './conversation-copy';
import { ConversationEntry } from './ConversationEntry';

describe('ConversationEntry', () => {
  it('carries the unread count, spoken as part of the control', async () => {
    const onPress = jest.fn();
    await render(
      <ConversationEntry viewer="customer" unreadCount={4} writable onPress={onPress} />,
    );

    expect(screen.getByText('4')).toBeOnTheScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: `${copy.entry.title}, ${copy.unread(4)}` }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows no badge when everything is read', async () => {
    await render(
      <ConversationEntry viewer="master" unreadCount={0} writable onPress={jest.fn()} />,
    );

    expect(screen.getByRole('button', { name: copy.entry.title })).toBeOnTheScreen();
    expect(screen.getByText(copy.entry.open.master)).toBeOnTheScreen();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('says a finished order’s conversation can only be read', async () => {
    await render(
      <ConversationEntry viewer="customer" unreadCount={0} writable={false} onPress={jest.fn()} />,
    );

    expect(screen.getByText(copy.entry.closed)).toBeOnTheScreen();
  });
});
