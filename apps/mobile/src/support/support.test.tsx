import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { readSupportEmail, supportMailUrl, withSupportAddress } from './support-contact';
import { SUPPORT_COPY as copy } from './support-copy';
import { SupportLine } from './SupportLine';

/**
 * Where a locked-out user is told to go (ADR-0074 § 6, #516). The address is
 * one config value, and nothing names it while it is unset.
 */

const SUPPORT = 'support@tezusta.example';

describe('the support address', () => {
  it('is read from configuration, normalised', () => {
    expect(readSupportEmail('  Support@TezUsta.Example ')).toBe(SUPPORT);
  });

  it('is unset when missing, empty or not an address', () => {
    expect(readSupportEmail(undefined)).toBeNull();
    expect(readSupportEmail('')).toBeNull();
    expect(readSupportEmail('support')).toBeNull();
  });

  it('is unset in this build, so every support line stays hidden', () => {
    // `EXPO_PUBLIC_SUPPORT_EMAIL` is not set for the tests, as it is not set
    // in any build until the domain exists (#498, #505).
    expect(withSupportAddress('Dəstəklə əlaqə saxlayın.')).toBe('Dəstəklə əlaqə saxlayın.');
  });

  it('is named after an existing "contact support" sentence once set', () => {
    expect(withSupportAddress('Dəstəklə əlaqə saxlayın.', SUPPORT)).toBe(
      `Dəstəklə əlaqə saxlayın. ${copy.contactAt(SUPPORT)}`,
    );
  });
});

describe('the line under the sign-in form', () => {
  it('renders nothing while the address is unset', async () => {
    await render(<SupportLine email={null} />);

    expect(screen.queryByText(copy.lostAccess)).toBeNull();
  });

  it('shows the address and opens the mail app with it', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<SupportLine email={SUPPORT} />);

    expect(screen.getByText(copy.lostAccess)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: copy.writeToLabel(SUPPORT) }));

    expect(openURL).toHaveBeenCalledWith(supportMailUrl(SUPPORT));
    expect(supportMailUrl(SUPPORT)).toBe(`mailto:${SUPPORT}`);
    openURL.mockRestore();
  });
});
