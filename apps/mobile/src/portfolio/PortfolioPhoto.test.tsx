import { fireEvent, render, screen } from '@testing-library/react-native';

import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PortfolioPhoto } from './PortfolioPhoto';

const URL_A = 'https://media.example.com/a-thumb.webp';
const URL_B = 'https://media.example.com/b-thumb.webp';

async function failToLoad(): Promise<void> {
  await fireEvent(screen.getByTestId('portfolio-photo'), 'error', {
    nativeEvent: { error: 'HTTP 404' },
  });
}

describe('PortfolioPhoto', () => {
  it('loads the URL it was given, unchanged, keyed for recycling by that URL', async () => {
    await render(<PortfolioPhoto uri={URL_A} contentFit="cover" fallbackTone="text-muted" />);

    const photo = screen.getByTestId('portfolio-photo');
    expect(photo.props.source).toEqual([{ uri: URL_A }]);
    expect(photo.props.recyclingKey).toBe(URL_A);
  });

  it('shows the fallback, named for a screen reader, when the photo does not load', async () => {
    await render(<PortfolioPhoto uri={URL_A} contentFit="cover" fallbackTone="text-muted" />);

    await failToLoad();

    expect(screen.getByRole('image', { name: copy.photoFailed })).toBeOnTheScreen();
    expect(screen.queryByTestId('portfolio-photo')).not.toBeOnTheScreen();
  });

  it('tries again when it is handed a different photo', async () => {
    const { rerender } = await render(
      <PortfolioPhoto uri={URL_A} contentFit="cover" fallbackTone="text-muted" />,
    );
    await failToLoad();

    await rerender(<PortfolioPhoto uri={URL_B} contentFit="cover" fallbackTone="text-muted" />);

    expect(screen.queryByRole('image', { name: copy.photoFailed })).not.toBeOnTheScreen();
    expect(screen.getByTestId('portfolio-photo').props.source).toEqual([{ uri: URL_B }]);
  });
});
