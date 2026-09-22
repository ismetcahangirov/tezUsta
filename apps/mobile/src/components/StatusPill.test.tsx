import { render, screen } from '@testing-library/react-native';

import { StatusPill, type StatusTone } from './StatusPill';

const STATUSES: [StatusTone, string][] = [
  ['active', 'Yolda'],
  ['pending', 'Usta axtarılır'],
  ['done', 'Tamamlandı'],
  ['cancelled', 'Ləğv edildi'],
  // Not a cancellation and not a wait: the platform had no master to offer.
  ['unfilled', 'Usta tapılmadı'],
];

describe('StatusPill', () => {
  it.each(STATUSES)('states "%s" in words, not only in colour', async (status, label) => {
    await render(<StatusPill status={status} label={label} />);

    expect(screen.getByText(label)).toBeOnTheScreen();
  });
});
