import { View, type ViewProps } from 'react-native';

import { cn } from '../lib/cn';

export type CardSurface = 'surface' | 'alt' | 'inverse';

const SURFACE_CLASS: Record<CardSurface, string> = {
  surface: 'bg-surface',
  alt: 'bg-surface-alt',
  inverse: 'bg-inverse-surface',
};

export interface CardProps extends ViewProps {
  surface?: CardSurface;
}

/** The `md` radius container the reference uses for grouped content. */
export function Card({ surface = 'surface', className, ...rest }: CardProps): React.JSX.Element {
  return <View className={cn('rounded-md p-4', SURFACE_CLASS[surface], className)} {...rest} />;
}
