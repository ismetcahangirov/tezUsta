/**
 * A held call's running time as `m:ss` — `0:07`, `12:30`, `75:02`.
 *
 * Minutes are not rolled into hours: an order call that runs past an hour is
 * rare enough that `75:02` reads fine, and a third field would change the
 * width of the status line for the one call nobody expected.
 *
 * Built by hand rather than with `Intl.DateTimeFormat`: a duration is not a
 * time of day, and ICU's output differs between Windows and the Linux CI
 * image, which a string asserted in a test cannot survive.
 *
 * Negative input — this phone's clock stepped back while the call was held —
 * reads as `0:00` rather than as a minus sign.
 */
export function formatCallDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
