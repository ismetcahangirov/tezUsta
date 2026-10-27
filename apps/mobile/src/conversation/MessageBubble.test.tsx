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

  describe('photos (#456)', () => {
    const PHOTO = {
      key: 'a-1',
      uri: 'https://storage.test/a-1',
      expiresAt: '2099-01-01T00:00:00Z',
    };

    it('shows a message of photos alone, with no empty line of text', async () => {
      await render(
        <MessageBubble
          body=""
          photos={[PHOTO, { ...PHOTO, key: 'a-2' }]}
          time="10:15"
          mine={false}
        />,
      );

      expect(screen.getAllByLabelText(copy.photo)).toHaveLength(2);
      expect(screen.getByText('10:15')).toBeOnTheScreen();
      expect(screen.queryByText('')).toBeNull();
    });

    it('shows the Image icon for a photo that did not load, and asks for a new URL once it has expired', async () => {
      const onPhotoExpired = jest.fn();
      const { rerender } = await render(
        <MessageBubble
          body="Bax"
          photos={[PHOTO]}
          time="10:15"
          mine
          onPhotoExpired={onPhotoExpired}
        />,
      );

      await fireEvent(screen.getByLabelText(copy.photo), 'error');
      expect(screen.getByLabelText(copy.photoFailed)).toBeOnTheScreen();
      // Not expired: a broken photo, not a stale link.
      expect(onPhotoExpired).not.toHaveBeenCalled();

      const expired = {
        ...PHOTO,
        uri: 'https://storage.test/a-1?v=2',
        expiresAt: '2020-01-01T00:00:00Z',
      };
      await rerender(
        <MessageBubble
          body="Bax"
          photos={[expired]}
          time="10:15"
          mine
          onPhotoExpired={onPhotoExpired}
        />,
      );
      // A new URL is tried afresh rather than keeping the last one's fallback.
      await fireEvent(screen.getByLabelText(copy.photo), 'error');
      expect(onPhotoExpired).toHaveBeenCalledTimes(1);
    });
  });
});
