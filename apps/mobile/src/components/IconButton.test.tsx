import { fireEvent, render, screen } from '@testing-library/react-native';
import { View } from 'react-native';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('is reachable by its accessibility label', async () => {
    await render(<IconButton accessibilityLabel="Geri" icon={<View />} />);

    expect(screen.getByRole('button', { name: 'Geri' })).toBeOnTheScreen();
  });

  it('calls back when tapped', async () => {
    const onPress = jest.fn();
    await render(<IconButton accessibilityLabel="Geri" icon={<View />} onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Geri' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call back while disabled', async () => {
    const onPress = jest.fn();
    await render(
      <IconButton accessibilityLabel="Geri" icon={<View />} onPress={onPress} disabled />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Geri' }));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('announces a toggle’s state, not only its fill', async () => {
    await render(
      <>
        <IconButton accessibilityLabel="Səssiz" icon={<View />} variant="on-inverse" selected />
        <IconButton
          accessibilityLabel="Dinamik"
          icon={<View />}
          variant="inverse-outline"
          selected={false}
        />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Səssiz', selected: true })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Dinamik', selected: false })).toBeOnTheScreen();
  });

  it('does not announce itself as selected when it is not a toggle', async () => {
    await render(<IconButton accessibilityLabel="Geri" icon={<View />} />);

    expect(screen.getByRole('button', { name: 'Geri' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Geri', selected: true })).toBeNull();
  });
});
