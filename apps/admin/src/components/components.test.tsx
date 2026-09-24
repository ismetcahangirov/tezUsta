import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encode } from 'uqr';
import { describe, expect, it, vi } from 'vitest';

import { Banner } from './Banner';
import { Button } from './Button';
import { QrCode } from './QrCode';
import { TextField } from './TextField';

describe('Button', () => {
  it('runs its action when pressed', async () => {
    const onClick = vi.fn();
    render(<Button label="Save" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled and relabelled while loading', async () => {
    const onClick = vi.fn();
    render(<Button label="Save" loadingLabel="Saving…" loading onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('TextField', () => {
  it('is reachable by its label and describes itself with its hint', () => {
    render(<TextField label="Email" hint="Your work address." />);

    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Your work address.');
    expect(screen.getByLabelText('Email')).not.toBeInvalid();
  });

  it('marks itself invalid and shows the error instead of the hint', () => {
    render(<TextField label="Email" hint="Your work address." error="Enter an email." />);

    expect(screen.getByLabelText('Email')).toBeInvalid();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter an email.');
    expect(screen.queryByText('Your work address.')).not.toBeInTheDocument();
  });
});

describe('Banner', () => {
  it('announces a danger message as an alert and anything else as a status', () => {
    render(
      <>
        <Banner tone="danger" message="It failed." />
        <Banner message="It worked." />
      </>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('It failed.');
    expect(screen.getByRole('status')).toHaveTextContent('It worked.');
  });
});

describe('QrCode', () => {
  it('draws one dark square per dark module, locally, with an accessible name', () => {
    const value = 'otpauth://totp/TezUsta:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=TezUsta';
    render(<QrCode value={value} label="QR code" />);

    const svg = screen.getByRole('img', { name: 'QR code' });
    const expected = encode(value, { ecc: 'M', border: 4 });
    const darkModules = expected.data.flat().filter(Boolean).length;
    const drawn = (svg.querySelector('path')?.getAttribute('d') ?? '').match(/M/g)?.length;

    expect(svg.getAttribute('viewBox')).toBe(
      `0 0 ${String(expected.size)} ${String(expected.size)}`,
    );
    expect(drawn).toBe(darkModules);
  });
});
