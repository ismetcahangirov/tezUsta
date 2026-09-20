import type { Address } from '@tezusta/types';
import { View } from 'react-native';

import {
  Badge,
  Divider,
  IconButton,
  ListRow,
  PencilIcon,
  StarIcon,
  Trash2Icon,
} from '../components';
import { ADDRESSES_COPY as copy } from './addresses-copy';
import { formatAddressDetail } from './format-address-detail';

export interface AddressListProps {
  addresses: readonly Address[];
  /**
   * The id of an address a row action is currently mid-request for. Its own
   * actions are disabled — a second tap on the same row must not fire a
   * second mutation for it — while every other row stays usable.
   */
  busyId?: string | null;
  onEdit: (address: Address) => void;
  onDelete: (address: Address) => void;
  onSetDefault: (address: Address) => void;
}

/**
 * The list itself, rendered exactly in the order the API returned it.
 *
 * **Default-first is the server's ordering, not this component's.**
 * `addresses.repository.ts`'s `listByCustomer` orders by `is_default desc,
 * created_at desc`, off the same index the query already uses — resorting
 * here would be redundant at best and would drift from the server's answer at
 * worst, the same reasoning `CategoryList` gives for trusting `displayOrder`.
 *
 * Presentational: it takes rows and callbacks and owns no server state, no
 * mutation and no request state. `Addresses.tsx` owns those, and the four
 * request states, for the same reason `ServiceCatalogue` keeps them out of
 * `CategoryList`.
 */
export function AddressList({
  addresses,
  busyId = null,
  onEdit,
  onDelete,
  onSetDefault,
}: AddressListProps): React.JSX.Element {
  return (
    <View>
      {addresses.map((address, index) => {
        const title = address.label ?? address.formattedAddress;
        const detail = formatAddressDetail(address);
        const subtitleParts = [
          address.label !== null ? address.formattedAddress : null,
          detail,
        ].filter((part): part is string => Boolean(part));
        const busy = busyId === address.id;

        return (
          <View key={address.id}>
            <ListRow
              title={title}
              {...(subtitleParts.length > 0 ? { subtitle: subtitleParts.join(' · ') } : {})}
              trailing={
                <View className="flex-row items-center gap-1">
                  {address.isDefault ? (
                    <Badge label={copy.defaultBadge} tone="accent" />
                  ) : (
                    <IconButton
                      accessibilityLabel={copy.setDefaultAction(title)}
                      icon={<StarIcon />}
                      variant="ghost"
                      disabled={busy}
                      onPress={() => {
                        onSetDefault(address);
                      }}
                    />
                  )}
                  <IconButton
                    accessibilityLabel={copy.editAction(title)}
                    icon={<PencilIcon />}
                    variant="ghost"
                    disabled={busy}
                    onPress={() => {
                      onEdit(address);
                    }}
                  />
                  <IconButton
                    accessibilityLabel={copy.deleteAction(title)}
                    icon={<Trash2Icon tone="danger" />}
                    variant="ghost"
                    disabled={busy}
                    onPress={() => {
                      onDelete(address);
                    }}
                  />
                </View>
              }
            />
            {index < addresses.length - 1 && <Divider />}
          </View>
        );
      })}
    </View>
  );
}
