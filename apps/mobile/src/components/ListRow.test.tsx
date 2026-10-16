import { fireEvent, render, screen } from '@testing-library/react-native';

import { ListRow } from './ListRow';
import { Text } from './Text';

describe('ListRow', () => {
  it('shows its title and subtitle', async () => {
    await render(<ListRow title="Kran sızır" subtitle="Nizami rayonu" />);

    expect(screen.getByText('Kran sızır')).toBeOnTheScreen();
    expect(screen.getByText('Nizami rayonu')).toBeOnTheScreen();
  });

  it('is not a button when it has nothing to do', async () => {
    await render(<ListRow title="Kran sızır" />);

    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });

  it('becomes a button when it is pressable', async () => {
    const onPress = jest.fn();
    await render(<ListRow title="Kran sızır" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Kran sızır' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('can be announced with more than its title', async () => {
    await render(
      <ListRow title="Mesajlar" accessibilityLabel="Mesajlar, 2 oxunmamış" onPress={jest.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Mesajlar, 2 oxunmamış' })).toBeOnTheScreen();
  });

  it('states progress in numbers, not only in the bar', async () => {
    await render(<ListRow title="Sənədlər" progress={{ value: 1, max: 3 }} />);

    expect(screen.getByText('1/3')).toBeOnTheScreen();
    expect(screen.getByRole('progressbar', { name: 'Sənədlər' })).toHaveAccessibilityValue({
      min: 0,
      max: 3,
      now: 1,
    });
  });

  it('draws what it leads with before the title, which a screen reader skips', async () => {
    const onPress = jest.fn();
    await render(
      <ListRow
        title="Elvin Məmmədov"
        subtitle="Profilə bax"
        leading={<Text>EM</Text>}
        onPress={onPress}
      />,
    );

    // Drawn, but not read: the row's own label already names who it is.
    expect(screen.getByText('EM', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText('EM')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Elvin Məmmədov' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
