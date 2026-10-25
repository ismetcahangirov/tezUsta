import { formatMessageTime } from '../conversation/format-message-time';
import { formatSubscriptionDate } from '../master-subscription/format-subscription-date';
import { formatOrderDate } from '../orders/format-order-date';
import { formatOrderPrice } from '../orders/format-order-price';
import { formatRatingAverage } from '../reviews/format-rating';
import { formatServicePrice } from '../service-catalogue/format-service-price';
import { appLocale } from './app-locale';

/**
 * Every formatter, called the way a screen calls it — with no locale — must
 * speak the language the copy around it is written in. The #399 device check
 * found a phone set to English printing "3:16 PM" inside Azerbaijani sentences.
 *
 * Each case compares against the same call with `az` and against `en-US`, so
 * it holds whatever locale the machine running the suite is set to, and never
 * compares a whole formatted string to a literal (ICU's spelling moves between
 * versions; the meaning does not).
 */
const AT = '2026-11-20T11:16:00.000Z';

describe('appLocale', () => {
  it('is Azerbaijani, the language of every string the app shows', () => {
    expect(appLocale()).toBe('az');
  });

  it.each([
    ['a message or arrival time', (l?: string) => formatMessageTime(AT, l)],
    ['an order date', (l?: string) => formatOrderDate(AT, l)],
    ['a subscription date', (l?: string) => formatSubscriptionDate(AT, l)],
    ['an order price', (l?: string) => formatOrderPrice(2500, l)],
    [
      'a service price',
      (l?: string) => formatServicePrice({ kind: 'fixed', amountMinor: 2500, currency: 'AZN' }, l),
    ],
    ['a rating', (l?: string) => formatRatingAverage(4.5, l)],
  ])('formats %s in Azerbaijani by default, not in the phone’s locale', (_, format) => {
    expect(format()).toBe(format('az'));
    expect(format()).not.toBe(format('en-US'));
  });

  it('gives a 24-hour clock with no AM or PM', () => {
    expect(formatMessageTime(AT)).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it('puts the manat sign after the amount with a decimal comma', () => {
    expect(formatOrderPrice(2500)).toMatch(/^25,00\s₼$/);
  });
});
