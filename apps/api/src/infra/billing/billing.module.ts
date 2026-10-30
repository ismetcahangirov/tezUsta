import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { BILLING_PROVIDER } from './billing.types';
import type { SubscriptionBillingProvider } from './billing.types';
import { createPaymentTokenBox, PAYMENT_TOKEN_BOX } from './payment-token-box';
import { StubBillingProvider } from './stub-billing.provider';

/**
 * Chooses the {@link SubscriptionBillingProvider} from validated configuration
 * (issue #323), the way `EmailModule` chooses an email sender: `BILLING_PROVIDER`
 * is an enum with one member, so the `switch` is exhaustive. A real provider
 * is one adapter file, one enum member and one `case`, and nothing above this
 * module changes.
 */
function createBillingProvider(config: AppConfig): SubscriptionBillingProvider {
  switch (config.billing.provider) {
    case 'stub':
      // Refuses to construct under NODE_ENV=production, so a deploy that
      // never chose a provider fails at boot, naming the variable.
      return new StubBillingProvider(config.runtime.nodeEnv);
  }
}

@Module({
  providers: [
    {
      provide: BILLING_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createBillingProvider,
    },
    { provide: PAYMENT_TOKEN_BOX, inject: [APP_CONFIG], useFactory: createPaymentTokenBox },
  ],
  exports: [BILLING_PROVIDER, PAYMENT_TOKEN_BOX],
})
export class BillingInfraModule {}
