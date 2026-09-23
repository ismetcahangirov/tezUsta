import { fireEvent, render, screen } from '@testing-library/react-native';

import { CONVERSATION_COPY as copy } from './conversation-copy';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble', () => {
  it('shows the other party’s message with its time and no delivery state', async () => {
    await render(<MessageBubble body="Yoldayam." time="10:15" mine={false} delivery="read" />);

    expect(screen.getByText('Yoldayam.')).toBeOnTheScreen();
    expect(screen.getByText('10:15')).toBeOnTheScreen();
    expect(screen.queryByText(new RegExp(copy.delivery.read))).toBeNull();
  });

  it.each([
    ['sending', copy.delivery.sending],
    ['sent', copy.delivery.sent],
    ['read', copy.delivery.read],
  ] as const)('says a message of mine is %s, in words', async (delivery, words) => {
    await render(<MessageBubble body="Salam" time="10:15" mine delivery={delivery} />);

    expect(screen.getByText(`10:15 · ${words}`)).toBeOnTheScreen();
  });

  it('says a failed message failed and offers to send it again', async () => {
    const onRetry = jest.fn();
    await render(
      <MessageBubble body="Salam" time="10:15" mine delivery="failed" onRetry={onRetry} />,
    );

    expect(screen.getByText(copy.delivery.failed)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.resend }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry when sending again cannot succeed', async () => {
    await render(<MessageBubble body="Salam" time="10:15" mine delivery="failed" />);

    expect(screen.getByText(copy.delivery.failed)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.resend })).toBeNull();
  });
});
