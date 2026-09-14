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
});
