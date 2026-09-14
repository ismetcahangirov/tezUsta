import { render, screen } from '@testing-library/react-native';

import { Sheet } from './Sheet';
import { Text } from './Text';

describe('Sheet', () => {
  it('announces its title as a heading', async () => {
    await render(<Sheet title="Sifariş" />);

    expect(screen.getByRole('header', { name: 'Sifariş' })).toBeOnTheScreen();
  });

  it('renders its content', async () => {
    await render(
      <Sheet title="Sifariş">
        <Text>Usta yolda</Text>
      </Sheet>,
    );

    expect(screen.getByText('Usta yolda')).toBeOnTheScreen();
  });

  it('works without a title', async () => {
    await render(
      <Sheet>
        <Text>Usta yolda</Text>
      </Sheet>,
    );

    expect(screen.queryByRole('header')).not.toBeOnTheScreen();
  });
});
