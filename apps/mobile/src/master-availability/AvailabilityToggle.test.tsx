import type { MasterAvailability } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AvailabilityToggle } from './AvailabilityToggle';
import { MASTER_AVAILABILITY_COPY as copy } from './master-availability-copy';

function availability(overrides: Partial<MasterAvailability> = {}): MasterAvailability {
  return {
    isAvailable: false,
    isLive: false,
    expiresInSeconds: null,
    heartbeatSeconds: 60,
    ...overrides,
  };
}

describe('AvailabilityToggle', () => {
  it('tells a working master that orders are reaching them', async () => {
    await render(
      <AvailabilityToggle
        availability={availability({ isAvailable: true, isLive: true, expiresInSeconds: 170 })}
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText(copy.liveLabel)).toBeOnTheScreen();
    expect(screen.queryByText(copy.staleDescription)).not.toBeOnTheScreen();
  });

  it('tells an offline master that no orders are coming', async () => {
    await render(<AvailabilityToggle availability={availability()} onChange={jest.fn()} />);

    expect(screen.getByText(copy.offlineLabel)).toBeOnTheScreen();
  });

  /**
   * The state this component exists for.
   *
   * The master flipped the switch on and the server has stopped hearing from
   * the app, so they believe they are working and they are not. Silence here
   * is the failure `docs/product/master-flow.md` says costs the product a
   * master's trust permanently — so the warning has to be on the screen, and
   * the pill must not still read as "taking orders".
   */
  it('warns a master whose app has stopped reaching the server, and does not still claim they are taking orders', async () => {
    await render(
      <AvailabilityToggle
        availability={availability({ isAvailable: true, isLive: false })}
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText(copy.staleDescription)).toBeOnTheScreen();
    expect(screen.queryByText(copy.liveLabel)).not.toBeOnTheScreen();
  });

  it('asks to go online when the master picks online', async () => {
    const onChange = jest.fn();
    await render(<AvailabilityToggle availability={availability()} onChange={onChange} />);

    await fireEvent.press(screen.getByText(copy.online));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('asks to go offline when the master picks offline', async () => {
    const onChange = jest.fn();
    await render(
      <AvailabilityToggle
        availability={availability({ isAvailable: true, isLive: true, expiresInSeconds: 120 })}
        onChange={onChange}
      />,
    );

    await fireEvent.press(screen.getByText(copy.offline));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('ignores a tap while a change is already in flight', async () => {
    const onChange = jest.fn();
    await render(<AvailabilityToggle availability={availability()} onChange={onChange} disabled />);

    await fireEvent.press(screen.getByText(copy.online));

    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * `changes_requested` and `rejected` are different states with different
   * screens, so the reason the server gave is shown verbatim rather than
   * collapsed into one "you cannot go online".
   */
  it('shows the reason a master is not allowed online', async () => {
    await render(
      <AvailabilityToggle
        availability={availability()}
        onChange={jest.fn()}
        blockedReason={copy.suspended}
      />,
    );

    expect(screen.getByText(copy.suspended)).toBeOnTheScreen();
  });

  it('shows no blocking reason when there is none', async () => {
    await render(<AvailabilityToggle availability={availability()} onChange={jest.fn()} />);

    expect(screen.queryByText(copy.suspended)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.pendingVerification)).not.toBeOnTheScreen();
  });
});
