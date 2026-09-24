import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox';
import { Dialog } from './Dialog';
import { SelectField } from './SelectField';

describe('Dialog', () => {
  it('is a labelled modal that takes focus into its first field', () => {
    render(
      <Dialog title="Edit category" onClose={() => undefined}>
        <input aria-label="Slug" />
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit category' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Slug')).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Edit" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SelectField', () => {
  it('is reachable by its label and reports the chosen value', async () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Pricing"
        value="fixed"
        options={[
          { value: 'fixed', label: 'Fixed' },
          { value: 'inspection', label: 'Inspection' },
        ]}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText('Pricing'), 'inspection');

    expect(onChange).toHaveBeenCalledWith('inspection');
  });

  it('marks itself invalid with its error as the description', () => {
    render(<SelectField label="Category" options={[]} error="Choose a category." />);

    expect(screen.getByLabelText('Category')).toBeInvalid();
    expect(screen.getByLabelText('Category')).toHaveAccessibleDescription('Choose a category.');
  });
});

describe('Checkbox', () => {
  it('toggles by its label', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        label="Active"
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />,
    );

    await userEvent.click(screen.getByLabelText('Active'));

    expect(onChange).toHaveBeenCalledWith(true);
  });
});
