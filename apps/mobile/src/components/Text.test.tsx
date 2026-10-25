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

  it('sets italic text in the italic face of the variant’s weight', async () => {
    await render(
      <>
        <Text italic>Gövdə</Text>
        <Text variant="h1" italic>
          Başlıq
        </Text>
      </>,
    );

    const classesOf = (text: string): string[] =>
      String((screen.getByText(text).props as { className?: string }).className).split(' ');

    expect(classesOf('Gövdə')).toContain('font-italic');
    expect(classesOf('Gövdə')).not.toContain('font-regular');
    expect(classesOf('Başlıq')).toContain('font-bold-italic');
    expect(classesOf('Başlıq')).not.toContain('font-bold');
  });

  it('exposes every step of the token type scale', () => {
    // Guards against a scale step being added to design-tokens.json and never reaching
    // a component — exactly the drift this design system exists to prevent.
    expect([...TEXT_VARIANTS].sort()).toEqual(Object.keys(typography.scale).sort());
  });
});
