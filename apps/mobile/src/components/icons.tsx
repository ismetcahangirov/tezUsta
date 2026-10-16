import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Image,
  MapPin,
  Mic,
  MicOff,
  Pencil,
  Phone,
  PhoneOff,
  Plus,
  RotateCw,
  Search,
  Send,
  Settings,
  Star,
  Trash2,
  User,
  Volume1,
  Volume2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react-native';

import { icon as iconTokens, useTheme, type ColorRole } from '../theme';

export type IconSize = keyof typeof iconTokens.size;

export interface IconProps {
  /** Which semantic colour the icon takes. Defaults to body text. */
  tone?: ColorRole;
  size?: IconSize;
}

/**
 * Lucide is the closest maintained open set to the reference's monoline,
 * geometric icons. Wrapping it here means stroke weight and colour come from
 * tokens — a raw `<ChevronLeft />` would carry Lucide's defaults instead.
 */
function createIcon(Source: LucideIcon, name: string) {
  function Icon({ tone = 'text', size = 'md' }: IconProps): React.JSX.Element {
    const { colors } = useTheme();

    return (
      <Source color={colors[tone]} size={iconTokens.size[size]} strokeWidth={iconTokens.stroke} />
    );
  }

  Icon.displayName = name;
  return Icon;
}

export const CheckIcon = createIcon(Check, 'CheckIcon');
export const ChevronLeftIcon = createIcon(ChevronLeft, 'ChevronLeftIcon');
export const ChevronRightIcon = createIcon(ChevronRight, 'ChevronRightIcon');
/** A post that failed to process (ADR-0054 § 5). */
export const CircleAlertIcon = createIcon(CircleAlert, 'CircleAlertIcon');
export const ClockIcon = createIcon(Clock, 'ClockIcon');
/** The grid's mark on a post with more than one photo (ADR-0054 § 2). */
export const CopyIcon = createIcon(Copy, 'CopyIcon');
/** A photo: the portfolio's empty state and a photo that did not load (ADR-0054 § 6). */
export const ImageIcon = createIcon(Image, 'ImageIcon');
export const MapPinIcon = createIcon(MapPin, 'MapPinIcon');
/** The call surface's mute toggle while the microphone is live (ADR-0041 § 2). */
export const MicIcon = createIcon(Mic, 'MicIcon');
/** The call surface's mute toggle while muted (ADR-0041 § 2). */
export const MicOffIcon = createIcon(MicOff, 'MicOffIcon');
export const PencilIcon = createIcon(Pencil, 'PencilIcon');
/** The call entry point and the accept control (issue #188). */
export const PhoneIcon = createIcon(Phone, 'PhoneIcon');
/** Decline, cancel and hang up (issue #188). */
export const PhoneOffIcon = createIcon(PhoneOff, 'PhoneOffIcon');
export const PlusIcon = createIcon(Plus, 'PlusIcon');
/** Retry an upload that failed (ADR-0054 § 5). */
export const RotateCwIcon = createIcon(RotateCw, 'RotateCwIcon');
export const SearchIcon = createIcon(Search, 'SearchIcon');
/** The conversation's send control (issue #182). */
export const SendIcon = createIcon(Send, 'SendIcon');
export const SettingsIcon = createIcon(Settings, 'SettingsIcon');
/** A star off: the outline alone (ADR-0042 § 8). */
export const StarIcon = createIcon(Star, 'StarIcon');

/**
 * A star on (ADR-0042 § 8): the same glyph on the same grid, filled with
 * `accent`. The outline keeps its tone — `text` by default — because the accent
 * is a fill and never an icon on its own
 * (`design-system.md` § 3): the fill says "on", and the outline is what keeps
 * the shape legible on white.
 */
export function StarFilledIcon({ tone = 'text', size = 'md' }: IconProps): React.JSX.Element {
  const { colors } = useTheme();

  return (
    <Star
      color={colors[tone]}
      fill={colors.accent}
      size={iconTokens.size[size]}
      strokeWidth={iconTokens.stroke}
    />
  );
}
export const Trash2Icon = createIcon(Trash2, 'Trash2Icon');
export const UserIcon = createIcon(User, 'UserIcon');
/** The call surface's speaker toggle while on the loudspeaker (ADR-0041 § 2). */
export const SpeakerIcon = createIcon(Volume2, 'SpeakerIcon');
/** The call surface's speaker toggle while on the earpiece (ADR-0041 § 2). */
export const EarpieceIcon = createIcon(Volume1, 'EarpieceIcon');
export const WrenchIcon = createIcon(Wrench, 'WrenchIcon');
export const CloseIcon = createIcon(X, 'CloseIcon');
