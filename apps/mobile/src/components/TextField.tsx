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

/**
 * The pill input from the reference's sign-in screen.
 *
 * **Multi-line, it stops being a pill.** A fixed `control-md` height clips a
 * second line, and a full-radius field several lines tall reads as a lozenge
 * rather than as somewhere to write. So a `multiline` field grows from
 * `control-lg` and rounds to `lg` — the treatment the conversation's composer
 * already settled (ADR-0037) — with its text starting at the top, as a written
 * paragraph does (issue #227).
 */
export function TextField({
  label,
  error,
  editable = true,
  multiline = false,
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
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        placeholderTextColor={colors['text-muted']}
        className={cn(
          'w-full border-hairline bg-surface px-5 text-body font-regular text-text',
          multiline ? 'min-h-control-lg rounded-lg py-3' : 'h-control-md rounded-full',
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
