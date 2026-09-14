import { fireEvent, render, screen } from '@testing-library/react-native';

import { SegmentedControl } from './SegmentedControl';

const ITEMS = [
  { value: 'customer', label: 'Müştəri' },
  { value: 'master', label: 'Usta' },
] as const;

describe('SegmentedControl', () => {
  it('marks the active segment as selected', async () => {
    await render(<SegmentedControl items={[...ITEMS]} value="master" onChange={jest.fn()} />);

    expect(screen.getByRole('tab', { name: 'Usta' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Müştəri' })).not.toBeSelected();
  });

  it('reports the value the user chose', async () => {
    const onChange = jest.fn();
    await render(<SegmentedControl items={[...ITEMS]} value="customer" onChange={onChange} />);

    await fireEvent.press(screen.getByRole('tab', { name: 'Usta' }));

    expect(onChange).toHaveBeenCalledWith('master');
  });

  it('keeps every segment labelled when only icons are shown', async () => {
    await render(
      <SegmentedControl items={[...ITEMS]} value="customer" onChange={jest.fn()} iconOnly />,
    );

    expect(screen.getByRole('tab', { name: 'Usta' })).toBeOnTheScreen();
  });
});
