import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  User,
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
export const PencilIcon = createIcon(Pencil, 'PencilIcon');
export const PlusIcon = createIcon(Plus, 'PlusIcon');
export const SearchIcon = createIcon(Search, 'SearchIcon');
export const SettingsIcon = createIcon(Settings, 'SettingsIcon');
export const StarIcon = createIcon(Star, 'StarIcon');
export const Trash2Icon = createIcon(Trash2, 'Trash2Icon');
export const UserIcon = createIcon(User, 'UserIcon');
export const WrenchIcon = createIcon(Wrench, 'WrenchIcon');
export const CloseIcon = createIcon(X, 'CloseIcon');
