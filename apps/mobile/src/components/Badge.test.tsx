import { render, screen } from '@testing-library/react-native';

import { Badge } from './Badge';

describe('Badge', () => {
  it('shows its label', async () => {
    await render(<Badge label="Təcili" tone="accent" />);

    expect(screen.getByText('Təcili')).toBeOnTheScreen();
  });
});
