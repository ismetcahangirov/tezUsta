import type { NotificationPreference } from '@tezusta/types';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { notificationsCopy } from './notifications-copy';
import { PreferenceList } from './PreferenceList';

const copy = notificationsCopy.preferences;

const CHANGEABLE: NotificationPreference = {
  category: 'order-progress',
  enabled: true,
  changeable: true,
};

const LOCKED: NotificationPreference = {
  category: 'order-offers',
  enabled: true,
  changeable: false,
};

describe('PreferenceList', () => {
  it('reports the category and the choice when a user switches one off', async () => {
    const onChoose = jest.fn();
    await render(<PreferenceList preferences={[CHANGEABLE]} onChoose={onChoose} />);

    await fireEvent.press(screen.getByText(copy.off));

    expect(onChoose).toHaveBeenCalledWith('order-progress', 'off');
  });

  it('ignores a tap while a write is in flight', async () => {
    // Not disabled-looking — the design system has no disabled style and one
    // is not invented here — but a second tap must not queue a second write.
    const onChoose = jest.fn();
    await render(<PreferenceList preferences={[CHANGEABLE]} busy onChoose={onChoose} />);

    await fireEvent.press(screen.getByText(copy.off));

    expect(onChoose).not.toHaveBeenCalled();
  });

  it('shows a locked category with its reason and no control', async () => {
    await render(<PreferenceList preferences={[LOCKED]} onChoose={() => undefined} />);

    expect(screen.getByText(notificationsCopy.categories['order-offers'].title)).toBeTruthy();
    expect(
      screen.getByText(notificationsCopy.categories['order-offers'].lockedReason),
    ).toBeTruthy();
    expect(screen.getByText(copy.lockedPill)).toBeTruthy();
    expect(screen.queryByText(copy.on)).toBeNull();
    expect(screen.queryByText(copy.off)).toBeNull();
  });

  it('names an unfamiliar category by its key rather than dropping it', async () => {
    await render(
      <PreferenceList
        preferences={[
          {
            category: 'order-digest' as NotificationPreference['category'],
            enabled: true,
            changeable: true,
          },
        ]}
        onChoose={() => undefined}
      />,
    );

    expect(screen.getByText('order-digest')).toBeTruthy();
  });

  it('says which way a control is currently set', async () => {
    await render(
      <PreferenceList
        preferences={[{ ...CHANGEABLE, enabled: false }]}
        onChoose={() => undefined}
      />,
    );

    expect(
      screen.getByLabelText(`${notificationsCopy.categories['order-progress'].title}: ${copy.off}`),
    ).toBeTruthy();
  });
});
