export type BannerTone = 'neutral' | 'danger';

const TONE_CLASS: Record<BannerTone, string> = {
  neutral: 'bg-surface-alt text-text',
  danger: 'bg-danger text-on-danger',
};

export interface BannerProps {
  message: string;
  tone?: BannerTone;
}

/**
 * A strip that says something about the screen as a whole — a failed
 * sign-in, a finished setup. `danger` is an `alert` so a screen reader reads
 * it the moment it appears; `neutral` is a polite `status`.
 */
export function Banner({ message, tone = 'neutral' }: BannerProps) {
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`w-full rounded-sm px-4 py-3 text-caption ${TONE_CLASS[tone]}`}
    >
      {message}
    </p>
  );
}
