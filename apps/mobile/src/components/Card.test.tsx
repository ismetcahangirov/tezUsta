import { render, screen } from '@testing-library/react-native';

import { Card } from './Card';
import { Text } from './Text';

describe('Card', () => {
  it('renders the content it wraps', async () => {
    await render(
      <Card>
        <Text>Santexnik · 25 AZN</Text>
      </Card>,
    );

    expect(screen.getByText('Santexnik · 25 AZN')).toBeOnTheScreen();
  });

  it('can be grouped for assistive technology', async () => {
    await render(
      <Card accessible accessibilityLabel="Sifariş kartı">
        <Text>Santexnik</Text>
      </Card>,
    );

    expect(screen.getByLabelText('Sifariş kartı')).toBeOnTheScreen();
  });
});
