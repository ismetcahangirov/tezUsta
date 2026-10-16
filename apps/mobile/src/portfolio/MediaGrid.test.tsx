import { fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { MediaGridItem } from './media-grid-items';
import { MediaGrid } from './MediaGrid';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { publishedTiles } from './portfolio-fixtures';

const noop = (): void => undefined;

describe('MediaGrid', () => {
  it('names each tile by its photos and its caption', async () => {
    await render(
      <MediaGrid
        items={[
          {
            kind: 'published',
            postId: 'a',
            thumbUrl: 'https://media.example.com/a-thumb.webp',
            photoCount: 1,
            caption: null,
          },
          {
            kind: 'published',
            postId: 'b',
            thumbUrl: 'https://media.example.com/b-thumb.webp',
            photoCount: 3,
            caption: 'Kranın dəyişdirilməsi',
          },
        ]}
        onOpen={noop}
      />,
    );

    expect(screen.getByRole('button', { name: copy.grid.tile(1) })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: `${copy.grid.tile(3)}. Kranın dəyişdirilməsi` }),
    ).toBeOnTheScreen();
  });

  it('opens the tapped post at its place in the grid', async () => {
    const onOpen = jest.fn();
    await render(<MediaGrid items={publishedTiles(5)} onOpen={onOpen} />);

    await userEvent.press(screen.getByRole('button', { name: `${copy.grid.tile(3)}. Paylaşım 2` }));

    expect(onOpen).toHaveBeenCalledWith('post-2', 1);
  });

  it('draws each tile from the thumb rendition, never the full-size one', async () => {
    await render(<MediaGrid items={publishedTiles(1)} onOpen={noop} />);

    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('https://media.example.com/post-1-thumb.webp');
    expect(tree).not.toContain('display');
  });

  it('marks a post with several photos and leaves a single photo unmarked', async () => {
    const tile = publishedTiles(1)[0]!;
    const { rerender } = await render(
      <MediaGrid items={[{ ...tile, photoCount: 1 }]} onOpen={noop} />,
    );
    expect(JSON.stringify(screen.toJSON())).not.toContain('lucide-copy');

    await rerender(<MediaGrid items={[{ ...tile, photoCount: 4 }]} onOpen={noop} />);
    expect(JSON.stringify(screen.toJSON())).toContain('lucide-copy');
  });

  it('shows a processing post as a tile nobody can open', async () => {
    const onOpen = jest.fn();
    await render(<MediaGrid items={[{ kind: 'processing', postId: 'p' }]} onOpen={onOpen} />);

    expect(screen.getByText(copy.grid.processing)).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });

  it('lets the master act on a failed post, and nobody else', async () => {
    const onPressFailed = jest.fn();
    const failed: MediaGridItem[] = [{ kind: 'failed', postId: 'f' }];
    const { rerender } = await render(<MediaGrid items={failed} onOpen={noop} />);

    expect(screen.getByText(copy.grid.failed)).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();

    await rerender(<MediaGrid items={failed} onOpen={noop} onPressFailed={onPressFailed} />);
    await userEvent.press(screen.getByRole('button', { name: copy.grid.failed }));

    expect(onPressFailed).toHaveBeenCalledWith('f');
  });

  it('draws the empty state when there are no posts, under the header', async () => {
    await render(
      <MediaGrid
        items={[]}
        onOpen={noop}
        header={<Text>Profil</Text>}
        empty={<Text>Usta hələ iş nümunəsi paylaşmayıb.</Text>}
      />,
    );

    expect(screen.getByText('Profil')).toBeOnTheScreen();
    expect(screen.getByText('Usta hələ iş nümunəsi paylaşmayıb.')).toBeOnTheScreen();
  });

  it('asks for the next page when the end of the list comes into view', async () => {
    const onEndReached = jest.fn();
    await render(
      <MediaGrid items={publishedTiles(30)} onOpen={noop} onEndReached={onEndReached} />,
    );

    // Laid out, then scrolled to the bottom: the list's own end detection fires.
    const list = screen.root!;
    await fireEvent(list, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 100 } },
    });
    await fireEvent(list, 'contentSizeChange', 360, 1000);
    await fireEvent.scroll(list, {
      nativeEvent: {
        contentOffset: { x: 0, y: 900 },
        contentSize: { width: 360, height: 1000 },
        layoutMeasurement: { width: 360, height: 100 },
      },
    });

    expect(onEndReached).toHaveBeenCalled();
  });
});
