import { render, screen } from '@testing-library/react-native';

import { Divider } from './Divider';

describe('Divider', () => {
  it('renders', async () => {
    await render(<Divider testID="divider" />);

    expect(screen.getByTestId('divider', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('is decorative, so a screen reader never stops on it', async () => {
    await render(<Divider testID="divider" />);

    expect(screen.queryByTestId('divider')).toBeNull();
  });
});
