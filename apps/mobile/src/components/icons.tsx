import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Mic,
  MicOff,
  Pencil,
  Phone,
  PhoneOff,
  Plus,
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
export const ClockIcon = createIcon(Clock, 'ClockIcon');
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
export const SearchIcon = createIcon(Search, 'SearchIcon');
/** The conversation's send control (issue #182). */
export const SendIcon = createIcon(Send, 'SendIcon');
export const SettingsIcon = createIcon(Settings, 'SettingsIcon');
export const StarIcon = createIcon(Star, 'StarIcon');
export const Trash2Icon = createIcon(Trash2, 'Trash2Icon');
export const UserIcon = createIcon(User, 'UserIcon');
/** The call surface's speaker toggle while on the loudspeaker (ADR-0041 § 2). */
export const SpeakerIcon = createIcon(Volume2, 'SpeakerIcon');
/** The call surface's speaker toggle while on the earpiece (ADR-0041 § 2). */
export const EarpieceIcon = createIcon(Volume1, 'EarpieceIcon');
export const WrenchIcon = createIcon(Wrench, 'WrenchIcon');
export const CloseIcon = createIcon(X, 'CloseIcon');
