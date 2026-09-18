import { SafeAreaView } from 'react-native-safe-area-context';

import { Addresses } from '../../src/addresses';

/**
 * The customer's saved addresses (issue #90): list, add, edit, delete, choose
 * the default. `apps/mobile/src/addresses/Addresses.tsx` carries the whole
 * screen; this file is only the route.
 */
export default function CustomerAddressesScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <Addresses />
    </SafeAreaView>
  );
}
