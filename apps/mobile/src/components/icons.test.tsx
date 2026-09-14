import { render, screen } from '@testing-library/react-native';

import { ChevronLeftIcon, MapPinIcon } from './icons';
import { IconButton } from './IconButton';

describe('icons', () => {
  it('renders', async () => {
    await render(<ChevronLeftIcon />);

    expect(screen.root).toBeTruthy();
  });

  it('is decorative, so a screen reader never announces it on its own', async () => {
    // The meaning lives on the control that holds the icon, not on the glyph.
    await render(<MapPinIcon />);

    expect(screen.queryByRole('image')).not.toBeOnTheScreen();
  });

  it('leaves the surrounding control as the only thing announced', async () => {
    await render(<IconButton accessibilityLabel="Xəritədə göstər" icon={<MapPinIcon />} />);

    expect(screen.getByRole('button', { name: 'Xəritədə göstər' })).toBeOnTheScreen();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
