import { render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { Banner } from './Banner';
import { Button } from './Button';

describe('Banner', () => {
  it('announces the message once on mount, and again when the message changes', async () => {
    const announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});

    const { rerender } = await render(<Banner message="Saxlanmış siyahı göstərilir" />);

    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenLastCalledWith('Saxlanmış siyahı göstərilir');

    // An unrelated re-render (same message) must not announce again.
    await rerender(<Banner message="Saxlanmış siyahı göstərilir" tone="danger" />);
    expect(announceSpy).toHaveBeenCalledTimes(1);

    await rerender(<Banner message="Yenilənmədi" tone="danger" />);
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('Yenilənmədi');

    expect(screen.getByText('Yenilənmədi')).toBeOnTheScreen();

    announceSpy.mockRestore();
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
