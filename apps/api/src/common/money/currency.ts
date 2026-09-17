/**
 * The currency every amount in TezUsta is denominated in.
 *
 * **Deliberately a constant and not a column.** The product operates in
 * Azerbaijan, in AZN (CLAUDE.md §1), and a per-row currency would invite rows
 * that disagree with the currency the platform actually settles in — a
 * disagreement nothing in the system could resolve and nothing would detect
 * until a payout. One market, one currency, one place to change it.
 *
 * It is nonetheless part of every money-bearing response. An amount without a
 * currency is a number the client has to guess about, and "the client knows
 * it is always AZN" is exactly the assumption that turns into a bug the first
 * time it is not.
 */
export const PLATFORM_CURRENCY = 'AZN';
