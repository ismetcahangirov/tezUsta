import { describe, expect, it } from 'vitest';

import type { CheckoutRequest } from './billing.types';
import {
  STUB_SIGNATURE_HEADER,
  StubBillingProvider,
  StubBillingProviderInProductionError,
} from './stub-billing.provider';

const REQUEST: CheckoutRequest = {
  masterId: '0192f5d4-0000-7000-8000-000000000001',
  billingPeriod: 'monthly',
  amountMinor: 2_500,
  currency: 'AZN',
  idempotencyKey: '0192f5d4-0000-7000-8000-0000000000aa',
  returnUrl: undefined,
};

describe('StubBillingProvider (issue #323)', () => {
  it('refuses to construct under NODE_ENV=production', () => {
    expect(() => new StubBillingProvider('production')).toThrow(
      StubBillingProviderInProductionError,
    );
  });

  it('opens one checkout per idempotency key, on an https page', async () => {
    const stub = new StubBillingProvider('test');

    const first = await stub.createCheckout(REQUEST);
    const again = await stub.createCheckout(REQUEST);

    expect(again).toEqual(first);
    expect(first.checkoutUrl).toMatch(/^https:\/\//);
    await expect(stub.fetchPayment(first.providerRef)).resolves.toEqual({ status: 'pending' });
  });

  it('answers "unknown" for a reference it never opened', async () => {
    const stub = new StubBillingProvider('test');

    await expect(stub.fetchPayment('stub_nothing')).resolves.toEqual({ status: 'unknown' });
  });

  it('verifies its own signed success, and reports it paid', async () => {
    const stub = new StubBillingProvider('test');
    const { providerRef } = await stub.createCheckout(REQUEST);

    const delivery = stub.pay(providerRef);

    expect(stub.verifyWebhook(delivery.body, delivery.headers)).toMatchObject({
      outcome: 'verified',
      event: { kind: 'succeeded', providerRef, amountMinor: 2_500, currency: 'AZN' },
    });
    await expect(stub.fetchPayment(providerRef)).resolves.toEqual({
      status: 'paid',
      amountMinor: 2_500,
      currency: 'AZN',
    });
  });

  it('translates failures and refunds, and ignores what it does not know', () => {
    const stub = new StubBillingProvider('test');
    const failed = stub.deliver('payment.failed', { ref: 'stub_a' });
    const refunded = stub.deliver('payment.refunded', {
      ref: 'stub_a',
      amountMinor: 2_500,
      currency: 'AZN',
    });
    const other = stub.deliver('customer.updated', { ref: 'stub_a' });

    expect(stub.verifyWebhook(failed.body, failed.headers)).toMatchObject({
      outcome: 'verified',
      event: { kind: 'failed', providerRef: 'stub_a' },
    });
    expect(stub.verifyWebhook(refunded.body, refunded.headers)).toMatchObject({
      outcome: 'verified',
      event: { kind: 'refunded', amountMinor: 2_500 },
    });
    expect(stub.verifyWebhook(other.body, other.headers)).toEqual({ outcome: 'ignored' });
  });

  it('refuses a missing signature, a wrong one, and a body changed after signing', () => {
    const stub = new StubBillingProvider('test');
    const delivery = stub.deliver('payment.succeeded', {
      ref: 'stub_a',
      amountMinor: 2_500,
      currency: 'AZN',
    });
    const tampered = Buffer.from(delivery.body.toString('utf8').replace('2500', '1'));

    expect(stub.verifyWebhook(delivery.body, {})).toEqual({ outcome: 'invalid' });
    expect(stub.verifyWebhook(delivery.body, { [STUB_SIGNATURE_HEADER]: 'sha256=00' })).toEqual({
      outcome: 'invalid',
    });
    expect(stub.verifyWebhook(tampered, delivery.headers)).toEqual({ outcome: 'invalid' });
  });

  it('treats a signature from another instance as a forgery: the key is per instance', () => {
    const signer = new StubBillingProvider('test');
    const verifier = new StubBillingProvider('test');
    const delivery = signer.deliver('payment.failed', { ref: 'stub_a' });

    expect(verifier.verifyWebhook(delivery.body, delivery.headers)).toEqual({
      outcome: 'invalid',
    });
  });

  it('refuses a signed success that carries no amount', () => {
    const stub = new StubBillingProvider('test');
    const delivery = stub.deliver('payment.succeeded', { ref: 'stub_a' });

    expect(stub.verifyWebhook(delivery.body, delivery.headers)).toEqual({ outcome: 'invalid' });
  });
});
