import { fireEvent, render, screen } from '@testing-library/react-native';

import { Button } from './Button';

describe('Button', () => {
  it('calls back when the user taps it', async () => {
    const onPress = jest.fn();
    await render(<Button label="Sifarişi təsdiqlə" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Sifarişi təsdiqlə' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call back while disabled', async () => {
    const onPress = jest.fn();
    await render(<Button label="Sifarişi təsdiqlə" onPress={onPress} disabled />);

    await fireEvent.press(screen.getByRole('button', { name: 'Sifarişi təsdiqlə' }));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('does not call back while loading, so a request cannot be sent twice', async () => {
    const onPress = jest.fn();
    await render(<Button label="Kod göndər" onPress={onPress} loading />);

    await fireEvent.press(screen.getByRole('button', { name: 'Kod göndər' }));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('tells assistive technology that it is busy while loading', async () => {
    await render(<Button label="Kod göndər" loading />);

    expect(screen.getByRole('button', { name: 'Kod göndər' })).toBeBusy();
  });

  it('keeps its label visible in every variant', async () => {
    await render(<Button label="Ləğv et" variant="danger" />);

    expect(screen.getByText('Ləğv et')).toBeOnTheScreen();
  });
});
