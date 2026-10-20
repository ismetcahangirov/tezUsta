import type { Address, ReverseGeocodeResult } from '@tezusta/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { AddressForm, type AddressFormValues } from './AddressForm';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/**
 * `expo-location` mocked at the module boundary, as `AvailabilityCard.test`
 * does: the form uses the real adapter, and each test says what the platform
 * answers — granted, askable, refused, no fix.
 */
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, High: 4 },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

const permission = Location.getForegroundPermissionsAsync as jest.Mock;
const requestPermission = Location.requestForegroundPermissionsAsync as jest.Mock;
const currentPosition = Location.getCurrentPositionAsync as jest.Mock;

const SETTLED = { timeout: 10_000 };

/** Where the phone is — deliberately not where the geocoder puts the building. */
const FIX = { latitude: 40.3775, longitude: 49.8921 };

const FOUND: ReverseGeocodeResult = {
  status: 'ok',
  address: {
    formattedAddress: 'Nizami küçəsi 203, Bakı',
    streetNumber: '203',
    street: 'Nizami küçəsi',
    district: 'Səbail',
    city: 'Bakı',
    postalCode: null,
    latitude: 40.3779,
    longitude: 49.8925,
    placeId: 'place-1',
  },
};

let reverseReply: { status: number; body: unknown } = { status: 200, body: FOUND };
let reverseBodies: unknown[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    if (new URL(request.url).pathname !== '/geocode/reverse') {
      throw new Error(`Unexpected request to ${request.url}`);
    }
    reverseBodies.push(await request.json());
    return new Response(JSON.stringify(reverseReply.body), {
      status: reverseReply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function grantNow(): void {
  permission.mockResolvedValue({ granted: true, canAskAgain: true });
}

async function mount(
  props: Partial<React.ComponentProps<typeof AddressForm>> = {},
): Promise<{ onSubmit: jest.Mock }> {
  const onSubmit = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <AddressForm
        mode="add"
        submitting={false}
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        {...props}
      />
    </Provider>,
  );
  return { onSubmit };
}

const PREFILL = 'Cari mövqeyimdən doldur';

describe('AddressForm — fill from my position (issue #413)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reverseReply = { status: 200, body: FOUND };
    reverseBodies = [];
    installTransport();
    grantNow();
    requestPermission.mockResolvedValue({ granted: true, canAskAgain: true });
    currentPosition.mockResolvedValue({ coords: FIX });
  });

  it('asks for nothing until the control is tapped', async () => {
    await mount();

    expect(requestPermission).not.toHaveBeenCalled();
    expect(currentPosition).not.toHaveBeenCalled();
  });

  it("fills the address and building, and saves the phone's own fix with nothing guessed", async () => {
    const { onSubmit } = await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(screen.getByLabelText('Ünvan')).toHaveProp('value', 'Nizami küçəsi 203, Bakı');
    }, SETTLED);
    expect(screen.getByLabelText('Bina')).toHaveProp('value', '203');
    expect(
      screen.getByText(
        'Ünvan mövqeyinizə görə təxminən dolduruldu. Yadda saxlamazdan əvvəl yoxlayın.',
      ),
    ).toBeOnTheScreen();
    expect(currentPosition).toHaveBeenCalledWith({ accuracy: Location.Accuracy.Balanced });
    expect(reverseBodies).toEqual([FIX]);

    await fireEvent.press(screen.getByRole('button', { name: 'Yadda saxla' }));
    expect(onSubmit).toHaveBeenCalledWith<[AddressFormValues]>({
      label: null,
      formattedAddress: 'Nizami küçəsi 203, Bakı',
      building: '203',
      entrance: null,
      floor: null,
      apartment: null,
      landmarkNote: null,
      latitude: FIX.latitude,
      longitude: FIX.longitude,
    });
  });

  it('asks for permission at that moment when the platform would still ask', async () => {
    permission.mockResolvedValue({ granted: false, canAskAgain: true });
    await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(screen.getByLabelText('Ünvan')).toHaveProp('value', 'Nizami küçəsi 203, Bakı');
    }, SETTLED);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('says one sentence and leaves manual entry working when permission is refused', async () => {
    permission.mockResolvedValue({ granted: false, canAskAgain: false });
    await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(
        screen.getByText('Mövqeyə icazə verilmədi. Ünvanı əl ilə yaza bilərsiniz.'),
      ).toBeOnTheScreen();
    }, SETTLED);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(currentPosition).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Ünvan')).toHaveProp('value', '');
    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Nizami küçəsi 203');
    expect(screen.getByRole('button', { name: 'Ünvanı tap' })).not.toBeDisabled();
  });

  it('says one sentence when the phone cannot get a fix', async () => {
    currentPosition.mockRejectedValue(new Error('Location request timed out'));
    await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(
        screen.getByText('Mövqeyinizi təyin etmək olmadı. Ünvanı əl ilə yaza bilərsiniz.'),
      ).toBeOnTheScreen();
    }, SETTLED);
    expect(reverseBodies).toEqual([]);
  });

  it('gives up on a fix that never arrives, and says so', async () => {
    jest.useFakeTimers();
    try {
      currentPosition.mockReturnValue(new Promise(() => undefined));
      await mount();

      await fireEvent.press(screen.getByRole('button', { name: PREFILL }));
      // The permission check settles first; then the ten-second deadline runs out.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_001);
      });

      expect(
        screen.getByText('Mövqeyinizi təyin etmək olmadı. Ünvanı əl ilə yaza bilərsiniz.'),
      ).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['unavailable', { status: 200, body: { status: 'unavailable' } }],
    ['a failed request', { status: 503, body: {} }],
  ])('says one sentence when the map service is %s', async (_case, reply) => {
    reverseReply = reply;
    await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(
        screen.getByText('Xəritə xidməti hazırda əlçatan deyil. Ünvanı əl ilə yaza bilərsiniz.'),
      ).toBeOnTheScreen();
    }, SETTLED);
    expect(screen.getByLabelText('Ünvan')).toHaveProp('value', '');
  });

  it('says one sentence when no address is found at that position', async () => {
    reverseReply = { status: 200, body: { status: 'no-result' } };
    await mount();

    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));

    await waitFor(() => {
      expect(
        screen.getByText('Bu mövqe üçün ünvan tapılmadı. Ünvanı əl ilə yaza bilərsiniz.'),
      ).toBeOnTheScreen();
    }, SETTLED);
  });

  it('never overwrites what the customer typed', async () => {
    let resolveFix: (value: { coords: typeof FIX }) => void = () => undefined;
    currentPosition.mockReturnValue(
      new Promise((resolve) => {
        resolveFix = resolve;
      }),
    );
    await mount();

    await fireEvent.changeText(screen.getByLabelText('Bina'), '7');
    await fireEvent.press(screen.getByRole('button', { name: PREFILL }));
    // The customer starts typing the address while the fix is on its way.
    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Füzuli küçəsi 5');
    resolveFix({ coords: FIX });

    await waitFor(() => {
      expect(reverseBodies).toEqual([FIX]);
    }, SETTLED);
    expect(screen.getByLabelText('Ünvan')).toHaveProp('value', 'Füzuli küçəsi 5');
    expect(screen.getByLabelText('Bina')).toHaveProp('value', '7');
    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();
  });

  it('is offered only on a new address whose address field is empty', async () => {
    const existing: Address = {
      id: 'addr-1',
      label: null,
      formattedAddress: 'Nizami küçəsi 203',
      building: null,
      entrance: null,
      floor: null,
      apartment: null,
      landmarkNote: null,
      latitude: 40.377,
      longitude: 49.892,
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await mount({ mode: 'edit', initial: existing });
    expect(screen.queryByRole('button', { name: PREFILL })).not.toBeOnTheScreen();
  });

  it('hides the control once an address is typed', async () => {
    await mount();

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Nizami');

    expect(screen.queryByRole('button', { name: PREFILL })).not.toBeOnTheScreen();
  });
});
