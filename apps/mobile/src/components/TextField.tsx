import { TextInput, type TextInputProps, View } from 'react-native';

import { cn } from '../lib/cn';
import { useTheme } from '../theme';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'className'> {
  label: string;
  /** Shown under the field and announced as the field's error state. */
  error?: string;
  className?: string;
}

/** The pill input from the reference's sign-in screen. */
export function TextField({
  label,
  error,
  editable = true,
  className,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const { colors } = useTheme();
  const invalid = error !== undefined;

  return (
    <View className={cn('w-full gap-2', className)}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error}
        aria-invalid={invalid}
        editable={editable}
        placeholderTextColor={colors['text-muted']}
        className={cn(
          'h-control-md w-full rounded-full border-hairline bg-surface px-5 text-body font-regular text-text',
          invalid ? 'border-danger' : 'border-border',
          !editable && 'opacity-40',
        )}
        {...rest}
      />
      {invalid && (
        <Text variant="footnote" tone="danger">
          {error}
        </Text>
      )}
    </View>
  );
}
