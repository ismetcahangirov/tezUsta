import { render, screen } from '@testing-library/react-native';

import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('reports its position to assistive technology', async () => {
    await render(<ProgressBar accessibilityLabel="Tapşırıq" value={1} max={2} />);

    expect(screen.getByRole('progressbar', { name: 'Tapşırıq' })).toHaveAccessibilityValue({
      min: 0,
      max: 2,
      now: 1,
    });
  });

  it('clamps a value above the maximum instead of overflowing', async () => {
    await render(<ProgressBar accessibilityLabel="Tapşırıq" value={9} max={2} />);

    expect(screen.getByRole('progressbar', { name: 'Tapşırıq' })).toHaveAccessibilityValue({
      min: 0,
      max: 2,
      now: 2,
    });
  });

  it('clamps a negative value to zero', async () => {
    await render(<ProgressBar accessibilityLabel="Tapşırıq" value={-3} max={2} />);

    expect(screen.getByRole('progressbar', { name: 'Tapşırıq' })).toHaveAccessibilityValue({
      min: 0,
      max: 2,
      now: 0,
    });
  });

  it('survives a zero maximum rather than dividing by it', async () => {
    await render(<ProgressBar accessibilityLabel="Tapşırıq" value={1} max={0} />);

    expect(screen.getByRole('progressbar', { name: 'Tapşırıq' })).toBeOnTheScreen();
  });
});
