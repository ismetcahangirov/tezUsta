import { act, render, screen } from '@testing-library/react-native';
import { colorScheme } from 'nativewind';
import { Text } from 'react-native';

import { FixedScheme, schemeVars } from './FixedScheme';
import { colors, hexToChannels } from './tokens';
import { useTheme } from './useTheme';

function SchemeProbe({ testID }: { readonly testID: string }): React.JSX.Element {
  const { scheme, colors: palette } = useTheme();
  return <Text testID={testID}>{`${scheme} ${palette['inverse-surface']}`}</Text>;
}

describe('FixedScheme', () => {
  afterEach(async () => {
    await act(() => {
      colorScheme.set('light');
    });
  });

  it('pins its subtree to one palette while the device is dark, and leaves the rest alone', async () => {
    await act(() => {
      colorScheme.set('dark');
    });

    await render(
      <>
        <SchemeProbe testID="outside" />
        <FixedScheme scheme="light">
          <SchemeProbe testID="inside" />
        </FixedScheme>
      </>,
    );

    expect(screen.getByTestId('outside')).toHaveTextContent(
      `dark ${colors.dark['inverse-surface']}`,
    );
    expect(screen.getByTestId('inside')).toHaveTextContent(
      `light ${colors.light['inverse-surface']}`,
    );
  });

  it('re-declares every colour role from the token file, and nothing else', () => {
    const declared = schemeVars('light');

    expect(Object.keys(declared)).toHaveLength(Object.keys(colors.light).length);
    expect(declared['--color-inverse-surface']).toBe(
      hexToChannels(colors.light['inverse-surface']),
    );
    expect(declared['--color-on-inverse']).toBe(hexToChannels(colors.light['on-inverse']));
  });
});
