import type { Service } from '@tezusta/types';
import { View } from 'react-native';

import { Divider, ListRow, Text } from '../components';
import { formatServicePrice } from './format-service-price';

export interface ServiceListProps {
  services: readonly Service[];
  onSelect: (service: Service) => void;
}

/**
 * The services inside a category — or the whole catalogue, when no category is
 * chosen.
 *
 * **The app never computes a price.** `formatServicePrice` turns the minor
 * units and currency code the server sent into a string and does nothing else:
 * no arithmetic, no commission, no rounding of its own. A price the client
 * calculated is a price the client controls (CLAUDE.md §11), and the
 * authoritative figure for an order comes from the accepting master anyway
 * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)) — which is
 * why a fixed amount here reads as "from X" rather than as the price.
 *
 * A fixed price and an inspection price are rendered by different branches,
 * driven by the response's discriminant, so there is no state in which a
 * missing amount silently renders as nothing.
 */
export function ServiceList({ services, onSelect }: ServiceListProps): React.JSX.Element {
  return (
    <View>
      {services.map((service, index) => (
        <View key={service.id}>
          <ListRow
            title={service.name}
            trailing={
              <Text variant="caption" tone="muted">
                {formatServicePrice(service.pricing)}
              </Text>
            }
            onPress={() => {
              onSelect(service);
            }}
          />
          {index < services.length - 1 && <Divider />}
        </View>
      ))}
    </View>
  );
}
