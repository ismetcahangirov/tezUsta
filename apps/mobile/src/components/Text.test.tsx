import { render, screen } from '@testing-library/react-native';

import { typography } from '../theme';
import { Text, TEXT_VARIANTS } from './Text';

describe('Text', () => {
  it('renders the content it is given', async () => {
    await render(<Text>Sifariş yaradıldı</Text>);

    expect(screen.getByText('Sifariş yaradıldı')).toBeOnTheScreen();
  });

  it('renders Azerbaijani characters the typeface must support', async () => {
    await render(<Text>Əlaqə · Ödəniş · İşçi · Çatdırılma</Text>);

    expect(screen.getByText('Əlaqə · Ödəniş · İşçi · Çatdırılma')).toBeOnTheScreen();
  });

  it('exposes every step of the token type scale', () => {
    // Guards against a scale step being added to design-tokens.json and never reaching
    // a component — exactly the drift this design system exists to prevent.
    expect([...TEXT_VARIANTS].sort()).toEqual(Object.keys(typography.scale).sort());
  });
});
