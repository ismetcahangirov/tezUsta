import { View } from 'react-native';

import { ListRow, Text, ChevronRightIcon } from '../components';

import { MASTER_ONBOARDING_COPY as copy } from './master-onboarding-copy';

export interface RoleChoiceProps {
  /** Carries on to the customer's name question. */
  readonly onCustomer: () => void;
  /** Opens the master onboarding. */
  readonly onMaster: () => void;
}

/**
 * The first question a brand-new account answers (#490, ADR-0073).
 *
 * Shown only to an account with **no role grant and no customer profile** —
 * which, since sign-in carries no role (`otp.service.ts`), is exactly an
 * account that has never answered anything. Someone who signed up as a
 * customer and later wants to work finds "Usta ol" in Settings instead.
 *
 * It is a question, not a commitment: a customer can become a master later,
 * and a person who taps "master" and backs out lands here again.
 */
export function RoleChoice({ onCustomer, onMaster }: RoleChoiceProps): React.JSX.Element {
  return (
    <View className="flex-1 justify-center gap-6 p-6">
      <Text variant="h1">{copy.choiceTitle}</Text>
      <View className="gap-3">
        <ListRow
          title={copy.choiceCustomer}
          subtitle={copy.choiceCustomerHint}
          trailing={<ChevronRightIcon />}
          onPress={onCustomer}
        />
        <ListRow
          title={copy.choiceMaster}
          subtitle={copy.choiceMasterHint}
          trailing={<ChevronRightIcon />}
          onPress={onMaster}
        />
      </View>
    </View>
  );
}
