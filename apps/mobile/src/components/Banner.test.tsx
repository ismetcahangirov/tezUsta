import { render, screen } from '@testing-library/react-native';

import { Banner } from './Banner';
import { Button } from './Button';

describe('Banner', () => {
  it('announces itself, so a screen reader does not silently skip the caveat', async () => {
    await render(<Banner message="Saxlanmış siyahı göstərilir" />);

    expect(screen.getByRole('alert')).toBeOnTheScreen();
    expect(screen.getByText('Saxlanmış siyahı göstərilir')).toBeOnTheScreen();
  });

  it('carries an action when one is supplied', async () => {
    await render(
      <Banner
        message="Yenilənmədi"
        tone="danger"
        action={<Button label="Yenidən" size="sm" onPress={jest.fn()} />}
      />,
    );

    expect(screen.getByRole('button', { name: 'Yenidən' })).toBeOnTheScreen();
  });
});
