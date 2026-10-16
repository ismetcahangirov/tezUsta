import { fireEvent, render, screen, userEvent } from '@testing-library/react-native';

import { formatOrderPrice } from '../orders/format-order-price';
import { presentPartyRating } from '../reviews/format-rating';
import { BIO_MAX_LINES, MasterProfileHeader } from './MasterProfileHeader';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { LONG_BIO, PROFILE } from './portfolio-fixtures';

/** The hidden, unclamped copy of the bio reports how many lines it took. */
async function bioLaysOutIn(bio: string, lines: number): Promise<void> {
  const [measure] = screen.getAllByText(bio, { includeHiddenElements: true });
  await fireEvent(measure!, 'textLayout', {
    nativeEvent: { lines: Array.from({ length: lines }, () => ({})) },
  });
}

describe('MasterProfileHeader', () => {
  it('shows the name, the rating read with its label, and the bio', async () => {
    await render(<MasterProfileHeader profile={PROFILE} />);

    expect(screen.getByRole('header', { name: PROFILE.displayName })).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`${copy.profile.ratingLabel}: ${presentPartyRating(PROFILE.rating)}`),
    ).toBeOnTheScreen();
    expect(screen.queryByText(copy.profile.ratingLabel)).not.toBeOnTheScreen();
    expect(screen.getByText(PROFILE.bio!)).toBeOnTheScreen();
  });

  it('falls back to initials without an avatar', async () => {
    await render(<MasterProfileHeader profile={PROFILE} />);

    expect(screen.getByText('EM')).toBeOnTheScreen();
  });

  it('draws the large avatar when there is one', async () => {
    const avatarLargeUrl = 'https://media.example.com/avatar-512.webp';
    await render(<MasterProfileHeader profile={{ ...PROFILE, avatarLargeUrl }} />);

    expect(screen.getByLabelText(PROFILE.displayName).props.source).toEqual({
      uri: avatarLargeUrl,
    });
  });

  it('lists each service with its price, or says it is priced at inspection', async () => {
    await render(<MasterProfileHeader profile={PROFILE} />);

    expect(screen.getByRole('header', { name: copy.profile.servicesTitle })).toBeOnTheScreen();
    expect(screen.getByText('Santexnik')).toBeOnTheScreen();
    expect(screen.getByText(formatOrderPrice(2500))).toBeOnTheScreen();
    expect(screen.getByText('Kombi təmiri')).toBeOnTheScreen();
    expect(screen.getByText(copy.profile.priceAfterInspection)).toBeOnTheScreen();
  });

  it('draws no services card and no bio when there are none', async () => {
    await render(<MasterProfileHeader profile={{ ...PROFILE, bio: null, services: [] }} />);

    expect(screen.queryByText(copy.profile.servicesTitle)).not.toBeOnTheScreen();
    expect(screen.queryByText(PROFILE.bio!)).not.toBeOnTheScreen();
  });

  it('offers no "more" for a bio that fits', async () => {
    await render(<MasterProfileHeader profile={PROFILE} />);

    await bioLaysOutIn(PROFILE.bio!, BIO_MAX_LINES);

    expect(screen.queryByRole('button', { name: copy.profile.bioMore })).not.toBeOnTheScreen();
  });

  it('clamps a longer bio and shows the rest on "more"', async () => {
    await render(<MasterProfileHeader profile={{ ...PROFILE, bio: LONG_BIO }} />);
    await bioLaysOutIn(LONG_BIO, BIO_MAX_LINES + 3);

    expect(screen.getByText(LONG_BIO).props.numberOfLines).toBe(BIO_MAX_LINES);

    await userEvent.press(screen.getByRole('button', { name: copy.profile.bioMore }));

    expect(screen.getByText(LONG_BIO).props.numberOfLines).toBeUndefined();
    expect(screen.queryByRole('button', { name: copy.profile.bioMore })).not.toBeOnTheScreen();
  });
});
