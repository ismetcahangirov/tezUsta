import { render, screen } from '@testing-library/react-native';

import {
  ChevronLeftIcon,
  MapPinIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
} from './icons';
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

  it('renders the address-actions icon set', async () => {
    await render(
      <>
        <PlusIcon />
        <StarIcon />
        <PencilIcon />
        <Trash2Icon />
        <SendIcon />
      </>,
    );

    expect(screen.root).toBeTruthy();
  });
});
