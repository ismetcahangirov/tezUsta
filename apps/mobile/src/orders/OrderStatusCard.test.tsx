import { render, screen } from '@testing-library/react-native';

import { OrderStatusCard } from './OrderStatusCard';
import { ORDERS_COPY as copy } from './orders-copy';
import { presentPartyRating } from '../reviews/format-rating';
import { REVIEWS_COPY } from '../reviews/reviews-copy';

describe('OrderStatusCard', () => {
  it('says where the order is and what happens next', async () => {
    await render(<OrderStatusCard status="SEARCHING" priceMinor={null} />);

    expect(screen.getByText(copy.status.SEARCHING.label)).toBeOnTheScreen();
    expect(screen.getByText(copy.status.SEARCHING.next)).toBeOnTheScreen();
  });

  /**
   * **A null price is information, not a blank.** It is null for every order
   * that has not been accepted ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)),
   * which is most of the time a customer is looking at this screen, and leaving
   * the line empty would read as a price the app failed to load.
   */
  it('explains an absent price instead of leaving a gap', async () => {
    await render(<OrderStatusCard status="SEARCHING" priceMinor={null} />);

    expect(screen.getByText(copy.detail.priceNotSet)).toBeOnTheScreen();
  });

  it('renders a frozen price in major units', async () => {
    await render(<OrderStatusCard status="ACCEPTED" priceMinor={4500} />);

    expect(screen.getByText(/45/)).toBeOnTheScreen();
    expect(screen.queryByText(/4500/)).not.toBeOnTheScreen();
  });

  it('renders an order nobody took without calling it a cancellation', async () => {
    await render(<OrderStatusCard status="NO_MASTER_FOUND" priceMinor={null} />);

    expect(screen.getByText(copy.status.NO_MASTER_FOUND.label)).toBeOnTheScreen();
    expect(screen.queryByText(copy.status.CANCELLED.label)).not.toBeOnTheScreen();
  });

  /** Issue #228, ADR-0042 § 6: the assigned master's rating, while assigned. */
  it('shows the assigned master’s average and count', async () => {
    const rating = { ratingAverage: 4.67, ratingCount: 12 };
    await render(<OrderStatusCard status="ACCEPTED" priceMinor={4500} masterRating={rating} />);

    expect(
      screen.getByLabelText(`${REVIEWS_COPY.rating.master}: ${presentPartyRating(rating)}`),
    ).toBeOnTheScreen();
  });

  it('says a master nobody has rated has no ratings yet, not zero', async () => {
    await render(
      <OrderStatusCard
        status="ACCEPTED"
        priceMinor={4500}
        masterRating={{ ratingAverage: null, ratingCount: 0 }}
      />,
    );

    expect(screen.getByText(REVIEWS_COPY.rating.none)).toBeOnTheScreen();
  });

  it('shows no rating while no master is assigned', async () => {
    await render(<OrderStatusCard status="SEARCHING" priceMinor={null} masterRating={null} />);

    expect(screen.queryByText(REVIEWS_COPY.rating.master)).not.toBeOnTheScreen();
  });
});
