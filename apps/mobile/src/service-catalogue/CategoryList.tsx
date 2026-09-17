import type { ServiceCategory } from '@tezusta/types';
import { View } from 'react-native';

import { ChevronRightIcon, Divider, ListRow } from '../components';

export interface CategoryListProps {
  categories: readonly ServiceCategory[];
  onSelect: (category: ServiceCategory) => void;
}

/**
 * The catalogue's top level, rendered from whatever the API returned.
 *
 * **Nothing about a category is known to this file.** There is no map from a
 * slug to an icon, no ordering of its own, no list of the ten launch
 * categories — because every one of those would make adding a category a thing
 * that needs an app release, which is what EPIC 3 exists to prevent. Order is
 * the server's `displayOrder`, already applied; the name is already resolved
 * for the device's language.
 *
 * Presentational: it takes rows and a callback and owns no server state. The
 * loading, empty and error cases belong to `ServiceCatalogue`, because they
 * are states of a *request*, and a component that took them as props would be
 * a request renderer wearing a list's name.
 */
export function CategoryList({ categories, onSelect }: CategoryListProps): React.JSX.Element {
  return (
    <View>
      {categories.map((category, index) => (
        <View key={category.id}>
          <ListRow
            title={category.name}
            trailing={<ChevronRightIcon tone="text-muted" />}
            onPress={() => {
              onSelect(category);
            }}
          />
          {index < categories.length - 1 && <Divider />}
        </View>
      ))}
    </View>
  );
}
