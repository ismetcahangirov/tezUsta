import { render, screen } from '@testing-library/react-native';

import { presentPartyRating } from './format-rating';
import { PartyRatingLine } from './PartyRatingLine';
import { REVIEWS_COPY as copy } from './reviews-copy';

describe('PartyRatingLine', () => {
  it('shows the average with its count, read as one element', async () => {
    const rating = { ratingAverage: 4.67, ratingCount: 12 };
    await render(<PartyRatingLine label={copy.rating.master} rating={rating} />);

    expect(screen.getByText(presentPartyRating(rating))).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`${copy.rating.master}: ${presentPartyRating(rating)}`),
    ).toBeOnTheScreen();
  });

  it('says "no ratings yet" rather than 0 for someone nobody has rated', async () => {
    await render(
      <PartyRatingLine
        label={copy.rating.customer}
        rating={{ ratingAverage: null, ratingCount: 0 }}
      />,
    );

    expect(screen.getByText(copy.rating.none)).toBeOnTheScreen();
    expect(screen.queryByText(/^0/)).not.toBeOnTheScreen();
  });
});
