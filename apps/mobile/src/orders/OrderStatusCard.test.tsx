import { render, screen } from '@testing-library/react-native';

import { OrderStatusCard } from './OrderStatusCard';
import { ORDERS_COPY as copy } from './orders-copy';

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
});
