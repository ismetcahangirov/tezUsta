import { render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { LocationPermission } from './location-permission';
import type { LocationPort } from './location-port';
import { useLocationAccessPrompt } from './useLocationAccessPrompt';

interface Asked {
  readonly requests: number;
}

function portReporting(permission: LocationPermission): LocationPort & Asked {
  const state = { requests: 0 };

  return {
    get requests() {
      return state.requests;
    },
    permission: () => Promise.resolve(permission),
    requestPermission: () => {
      state.requests += 1;
      return Promise.resolve('granted' as LocationPermission);
    },
    lastKnown: () => Promise.resolve(null),
    current: () => Promise.reject(new Error('not used')),
    watch: () => Promise.reject(new Error('not used')),
  };
}

async function promptWith(port: LocationPort & Asked): Promise<void> {
  function Probe(): React.JSX.Element {
    const ask = useLocationAccessPrompt(port);
    ask();
    return <View testID="probe" />;
  }

  await render(<Probe />);
}

/**
 * Asking for location, from the one call site that has earned it (issue #171).
 *
 * The rule under test is the product one, not the platform one: a master is
 * asked when they turn themselves online — the moment being placeable has an
 * obvious point — and never again after a refusal, because a second dialog
 * they cannot see the reason for is how a permission becomes permanently
 * blocked.
 */
describe('asking a master for location access', () => {
  it('prompts when the platform has never asked', async () => {
    const port = portReporting('askable');

    await promptWith(port);

    await waitFor(() => {
      expect(port.requests).toBe(1);
    });
  });

  it('does not prompt a master who already granted it', async () => {
    const port = portReporting('granted');

    await promptWith(port);

    await waitFor(() => {
      expect(port.requests).toBe(0);
    });
  });

  it('does not prompt again after a refusal', async () => {
    const port = portReporting('blocked');

    await promptWith(port);

    await waitFor(() => {
      expect(port.requests).toBe(0);
    });
  });
});
