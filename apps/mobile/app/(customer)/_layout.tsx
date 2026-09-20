import { Stack } from 'expo-router';

import { CustomerProfileGate } from '../../src/customers';

/**
 * Every customer screen sits behind the profile gate (issue #94).
 *
 * Sign-in is phone + OTP and carries no name, so a brand-new account reaches
 * this group with no `customers` row — and without the gate every screen below
 * renders a 404 it cannot explain. The gate asks for the one thing
 * `POST /customers` needs, once, and then renders the stack; a returning
 * customer never sees it.
 *
 * **Here rather than in the root layout**, so a master's group can never mount
 * it: the question belongs to the customer experience, and mounting it once
 * for everybody would ask people who only came to work whether they would like
 * to be customers.
 */
export default function CustomerLayout(): React.JSX.Element {
  return (
    <CustomerProfileGate>
      <Stack screenOptions={{ headerShown: false }} />
    </CustomerProfileGate>
  );
}
