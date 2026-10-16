import { fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { BackHandler, Dimensions, FlatList } from 'react-native';

import { MediaViewer } from './MediaViewer';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import {
  BROKEN_PHOTO_POST,
  MANY_PHOTOS_POST,
  NO_CAPTION_POST,
  ONE_PHOTO_POST,
} from './portfolio-fixtures';

const noop = (): void => undefined;

/** The pager settles on `page`, as a swipe leaves it. Pages are `width` wide, the window's until measured. */
async function swipeTo(page: number, width = Dimensions.get('window').width): Promise<void> {
  await fireEvent(screen.getByTestId('media-viewer-pager'), 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: page * width, y: 0 } },
  });
}

describe('MediaViewer', () => {
  it('shows the post’s photos at the display rendition', async () => {
    await render(<MediaViewer post={ONE_PHOTO_POST} onClose={noop} />);

    const tree = JSON.stringify(screen.toJSON());
    const { displayUrl, thumbUrl } = ONE_PHOTO_POST.media[0]!;
    expect(tree).toContain(`"source":[{"uri":"${displayUrl}"}]`);
    expect(tree).not.toContain(`"source":[{"uri":"${thumbUrl}"}]`);
  });

  it('shows the fallback when a photo does not load, and keeps the caption', async () => {
    await render(<MediaViewer post={BROKEN_PHOTO_POST} onClose={noop} />);

    await fireEvent(screen.getByTestId('portfolio-photo'), 'error', {
      nativeEvent: { error: 'HTTP 404' },
    });

    expect(screen.getByRole('image', { name: copy.photoFailed })).toBeOnTheScreen();
    expect(screen.getByText(BROKEN_PHOTO_POST.caption!)).toBeOnTheScreen();
  });

  it('counts the photos and advances the count with a swipe', async () => {
    await render(<MediaViewer post={MANY_PHOTOS_POST} onClose={noop} />);
    expect(screen.getByText(copy.viewer.counter(1, 5))).toBeOnTheScreen();

    await swipeTo(1);
    expect(screen.getByText(copy.viewer.counter(2, 5))).toBeOnTheScreen();

    await swipeTo(4);
    expect(screen.getByText(copy.viewer.counter(5, 5))).toBeOnTheScreen();
  });

  it('opens on the photo it was asked for', async () => {
    await render(<MediaViewer post={MANY_PHOTOS_POST} initialIndex={2} onClose={noop} />);

    expect(screen.getByText(copy.viewer.counter(3, 5))).toBeOnTheScreen();
    expect(screen.getByTestId('media-viewer-pager').props.initialScrollIndex).toBe(2);

    // The list reads its initial index once; paging must not feed it back in.
    await swipeTo(4);
    expect(screen.getByTestId('media-viewer-pager').props.initialScrollIndex).toBe(2);
  });

  it('pages by its own measured width, and keeps the current photo in view when it changes', async () => {
    const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    await render(<MediaViewer post={MANY_PHOTOS_POST} initialIndex={2} onClose={noop} />);

    // Narrower than the window, as in a split screen or a story frame.
    await fireEvent(screen.getByTestId('media-viewer-pages'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 500 } },
    });
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 2 * 360, animated: false });

    await swipeTo(3, 360);
    expect(screen.getByText(copy.viewer.counter(4, 5))).toBeOnTheScreen();
    scrollToOffset.mockRestore();
  });

  it('shows no count for a single photo', async () => {
    await render(<MediaViewer post={ONE_PHOTO_POST} onClose={noop} />);

    expect(screen.queryByText(copy.viewer.counter(1, 1))).not.toBeOnTheScreen();
  });

  it('shows the caption and the service tag, and nothing when there are neither', async () => {
    const { rerender } = await render(<MediaViewer post={ONE_PHOTO_POST} onClose={noop} />);
    expect(screen.getByText(ONE_PHOTO_POST.caption!)).toBeOnTheScreen();
    expect(screen.getByText(ONE_PHOTO_POST.service!.name)).toBeOnTheScreen();

    await rerender(<MediaViewer post={NO_CAPTION_POST} onClose={noop} />);
    expect(screen.queryByText(ONE_PHOTO_POST.caption!)).not.toBeOnTheScreen();
    expect(screen.queryByText(ONE_PHOTO_POST.service!.name)).not.toBeOnTheScreen();
  });

  it('closes on its close button', async () => {
    const onClose = jest.fn();
    await render(<MediaViewer post={ONE_PHOTO_POST} onClose={onClose} />);

    await userEvent.press(screen.getByRole('button', { name: copy.viewer.close }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the hardware back button, and stops listening once closed', async () => {
    const onClose = jest.fn();
    const listen = jest.spyOn(BackHandler, 'addEventListener');
    const { unmount } = await render(<MediaViewer post={ONE_PHOTO_POST} onClose={onClose} />);

    const [event, handler] = listen.mock.calls.at(-1)!;
    const subscription = listen.mock.results.at(-1)!.value as { remove: () => void };
    const remove = jest.spyOn(subscription, 'remove');
    expect(event).toBe('hardwareBackPress');

    // Handled: the press does not also reach whatever is behind the viewer.
    expect(handler({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await unmount();
    expect(remove).toHaveBeenCalled();
    listen.mockRestore();
  });

  it('listens for back once, and closes through the latest handler it was given', async () => {
    const listen = jest.spyOn(BackHandler, 'addEventListener');
    const first = jest.fn();
    const latest = jest.fn();
    const { rerender } = await render(<MediaViewer post={ONE_PHOTO_POST} onClose={first} />);
    await rerender(<MediaViewer post={ONE_PHOTO_POST} onClose={latest} />);

    expect(listen).toHaveBeenCalledTimes(1);
    listen.mock.calls[0]![1]({ type: 'hardwareBackPress', timeStamp: 0 });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    listen.mockRestore();
  });

  it('offers edit and delete on the master’s own post only', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const { rerender } = await render(<MediaViewer post={ONE_PHOTO_POST} onClose={noop} />);
    expect(screen.queryByRole('button', { name: copy.viewer.edit })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.viewer.delete })).not.toBeOnTheScreen();

    await rerender(
      <MediaViewer post={ONE_PHOTO_POST} onClose={noop} ownerActions={{ onEdit, onDelete }} />,
    );
    await userEvent.press(screen.getByRole('button', { name: copy.viewer.edit }));
    await userEvent.press(screen.getByRole('button', { name: copy.viewer.delete }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
