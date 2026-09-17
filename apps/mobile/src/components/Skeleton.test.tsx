import { render, screen } from '@testing-library/react-native';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('is announced as pending work rather than as an empty box', async () => {
    await render(<Skeleton accessibilityLabel="Yüklənir" className="h-control-md" />);

    expect(screen.getByLabelText('Yüklənir')).toBeOnTheScreen();
  });
});
