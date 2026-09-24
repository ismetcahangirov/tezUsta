import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { StarRating } from './StarRating';

const starLabel = (star: number): string => `${String(star)} ulduz`;

function Input({ onChange }: { readonly onChange?: (value: number) => void }): React.JSX.Element {
  const [value, setValue] = useState<number | null>(null);
  return (
    <StarRating
      value={value}
      label="Qiymət"
      starLabel={starLabel}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('StarRating', () => {
  it('offers five stars, each a button named for the number it chooses', async () => {
    await render(<Input />);

    expect(screen.getAllByRole('button')).toHaveLength(5);
    for (const star of [1, 2, 3, 4, 5]) {
      expect(screen.getByRole('button', { name: starLabel(star) })).toBeOnTheScreen();
    }
  });

  it('starts with nothing selected — no rating is not a zero', async () => {
    await render(<Input />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toBeSelected();
    }
  });

  it('picks four stars: the first four read as selected and the fifth does not', async () => {
    const onChange = jest.fn();
    await render(<Input onChange={onChange} />);

    await fireEvent.press(screen.getByRole('button', { name: starLabel(4) }));

    expect(onChange).toHaveBeenCalledWith(4);
    for (const star of [1, 2, 3, 4]) {
      expect(screen.getByRole('button', { name: starLabel(star) })).toBeSelected();
    }
    expect(screen.getByRole('button', { name: starLabel(5) })).not.toBeSelected();
  });

  it('changes its mind: a lower star lowers the rating', async () => {
    await render(<Input />);

    await fireEvent.press(screen.getByRole('button', { name: starLabel(5) }));
    await fireEvent.press(screen.getByRole('button', { name: starLabel(2) }));

    expect(screen.getByRole('button', { name: starLabel(2) })).toBeSelected();
    expect(screen.getByRole('button', { name: starLabel(3) })).not.toBeSelected();
  });

  it('does not respond while disabled', async () => {
    const onChange = jest.fn();
    await render(
      <StarRating value={3} label="Qiymət" starLabel={starLabel} onChange={onChange} disabled />,
    );

    await fireEvent.press(screen.getByRole('button', { name: starLabel(5) }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: starLabel(5) })).toBeDisabled();
  });

  it('read-only, is one element announced by its reading and offers no buttons', async () => {
    await render(<StarRating value={4} label="Qiymət: 5-dən 4" starLabel={starLabel} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByLabelText('Qiymət: 5-dən 4')).toBeOnTheScreen();
  });
});
