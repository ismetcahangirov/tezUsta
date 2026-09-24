import { useMemo } from 'react';
import { encode } from 'uqr';

export interface QrCodeProps {
  value: string;
  label: string;
}

/** Quiet zone, in modules — the four the QR specification requires. */
const QUIET_ZONE = 4;

/**
 * A QR code drawn locally as SVG. The `otpauth://` URI it encodes carries the
 * authenticator secret, so it never goes to a QR-rendering service, and it is
 * drawn as React elements from the encoded bits rather than injected as
 * markup.
 *
 * Always dark modules on a white field, in both themes: that is the contrast
 * every authenticator app's scanner is built for, and an inverted code fails
 * to scan in several of them. The two colours are the light scheme's `text`
 * and `surface` tokens, fixed rather than themed on purpose.
 */
export function QrCode({ value, label }: QrCodeProps) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: QUIET_ZONE });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${String(x)} ${String(y)}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width={192}
      height={192}
      shapeRendering="crispEdges"
      data-testid="totp-qr"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
