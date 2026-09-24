import { render, screen } from '@testing-library/react-native';

import { colors, icon as iconTokens } from '../theme';
import {
  ChevronLeftIcon,
  EarpieceIcon,
  MapPinIcon,
  MicIcon,
  MicOffIcon,
  PencilIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlusIcon,
  SendIcon,
  SpeakerIcon,
  StarFilledIcon,
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

  it('draws the star off as an outline and the star on filled with accent, outline kept', async () => {
    await render(<StarIcon tone="text-muted" size="lg" />);
    const off = screen.toJSON() as { props: Record<string, unknown> };
    expect(off.props.className).toBe('lucide lucide-star');
    expect(off.props.fill).toBe('none');
    expect(off.props.stroke).toBe(colors.light['text-muted']);

    await render(<StarFilledIcon size="lg" />);
    const on = screen.toJSON() as { props: Record<string, unknown> };
    expect(on.props.className).toBe('lucide lucide-star');
    expect(on.props.fill).toBe(colors.light.accent);
    // Lime is never an icon on its own on the light theme (design-system § 3).
    expect(on.props.stroke).toBe(colors.light.text);
    expect(on.props.strokeWidth).toBe(iconTokens.stroke);
    expect(on.props.width).toBe(iconTokens.size.lg);
  });

  it.each([
    ['PhoneIcon', PhoneIcon, 'lucide-phone'],
    ['PhoneOffIcon', PhoneOffIcon, 'lucide-phone-off'],
    ['MicIcon', MicIcon, 'lucide-mic'],
    ['MicOffIcon', MicOffIcon, 'lucide-mic-off'],
    ['SpeakerIcon', SpeakerIcon, 'lucide-volume-2'],
    ['EarpieceIcon', EarpieceIcon, 'lucide-volume-1'],
  ] as const)(
    '%s draws its own glyph with the token stroke, size and tone',
    async (_name, Icon, glyph) => {
      await render(<Icon tone="on-accent" size="lg" />);

      const svg = screen.toJSON() as { props: Record<string, unknown> };
      expect(svg.props.className).toBe(`lucide ${glyph}`);
      expect(svg.props.strokeWidth).toBe(iconTokens.stroke);
      expect(svg.props.width).toBe(iconTokens.size.lg);
      expect(svg.props.stroke).toBe(colors.light['on-accent']);
    },
  );
});
