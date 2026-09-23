import type { OrderSummary } from '@tezusta/types';
import type { ReactElement } from 'react';
import { SectionList, View } from 'react-native';

import { Divider, ListRow, StatusPill, Text, UnreadBadge } from '../components';
import { CONVERSATION_COPY } from '../conversation/conversation-copy';
import { formatOrderDate } from './format-order-date';
import { formatOrderPrice } from './format-order-price';
import { isOrderOpen, presentOrderStatus } from './order-status-presentation';
import { ORDERS_COPY as copy } from './orders-copy';

/** How much of the customer's description a row shows before truncating it. */
const DESCRIPTION_LINES = 2;

export interface OrderListProps {
  /** Every order loaded so far, in the order the server returned them. */
  orders: readonly OrderSummary[];
  onSelect: (order: OrderSummary) => void;
  /** Rendered above the rows — the screen's title, and a stale banner if any. */
  header?: ReactElement | undefined;
  /** Rendered below the rows — "load more", or the spinner that replaces it. */
  footer?: ReactElement | undefined;
}

interface OrderSection {
  readonly title: string;
  readonly data: OrderSummary[];
}

/**
 * Splits what has been loaded into what is still going and what is over
 * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)
 * § 3).
 *
 * **Server order is preserved inside each half** — newest first, exactly as
 * `GET /orders` returned it. This partitions; it does not sort.
 *
 * A heading appears only when both halves have rows. A customer whose orders
 * are all finished is not helped by being told so under a heading, and one
 * whose only order is in progress does not need it labelled.
 */
function sectionsOf(orders: readonly OrderSummary[]): OrderSection[] {
  const open = orders.filter((order) => isOrderOpen(order.status));
  const finished = orders.filter((order) => !isOrderOpen(order.status));

  if (open.length === 0 || finished.length === 0) {
    return [{ title: '', data: [...orders] }];
  }

  return [
    { title: copy.list.openHeading, data: open },
    { title: copy.list.finishedHeading, data: finished },
  ];
}

/** The date, and the price once there is one. An order still searching has none. */
function subtitleOf(order: OrderSummary): string {
  const price = order.priceMinor === null ? null : formatOrderPrice(order.priceMinor);

  return [formatOrderDate(order.createdAt), price].filter((part) => part !== null).join(' · ');
}

/**
 * The customer's orders, as rows (issue #160).
 *
 * **A row is the order in the customer's own words**: the description they
 * typed is the title, at most two lines. Not the service's name — `Order`
 * carries `serviceId` and nothing else, so a name would mean fetching and
 * holding the catalogue, and a category name identifies five of somebody's
 * orders where the sentence they wrote identifies one (ADR-0030 § 5). It is
 * also why no service name is written down here: the catalogue lives in the
 * database, and `no-hardcoded-catalogue.test.ts` enforces that it stays there.
 *
 * A status is rendered through `presentOrderStatus` and a price through
 * `formatOrderPrice` — the same two functions the order screen uses, so a
 * status cannot come to mean one thing in a list and another on the screen the
 * row opens.
 *
 * Presentational: it owns no request state and no navigation. `Orders.tsx`
 * holds both, for the reason `AddressList` gives.
 *
 * **A `SectionList` rather than a mapped `ScrollView`.** Unlike the address
 * list this one has no upper bound — a customer who keeps pressing "load more"
 * is holding every row they have ever created — and virtualising them is what
 * keeps a mid-range Android device responsive (CLAUDE.md §12). It is also why
 * the padding sits on the `View` around it: `SectionList` is not one of the
 * components NativeWind maps a `className` onto, so a class here would be a
 * prop that silently does nothing.
 */
export function OrderList({ orders, onSelect, header, footer }: OrderListProps): ReactElement {
  const sections = sectionsOf(orders);

  return (
    <View className="flex-1 px-6">
      <SectionList
        sections={sections}
        keyExtractor={(order) => order.id}
        stickySectionHeadersEnabled={false}
        {...(header === undefined ? {} : { ListHeaderComponent: header })}
        {...(footer === undefined ? {} : { ListFooterComponent: footer })}
        renderSectionHeader={({ section }) =>
          section.title === '' ? null : (
            <Text variant="caption" tone="muted" className="pb-1 pt-4">
              {section.title}
            </Text>
          )
        }
        renderItem={({ item, index, section }) => (
          <View>
            <ListRow
              title={item.description}
              titleNumberOfLines={DESCRIPTION_LINES}
              subtitle={subtitleOf(item)}
              {...(item.unreadMessageCount > 0
                ? {
                    accessibilityLabel: `${item.description}, ${CONVERSATION_COPY.unread(item.unreadMessageCount)}`,
                  }
                : {})}
              trailing={
                // The unread count sits on the row, beside the status
                // (issue #182, ADR-0033 § 6): the conversation belongs to
                // the order, so the order is where its count is shown. It
                // arrives with the page itself — no request per row.
                <View className="items-end gap-2">
                  <StatusPill
                    status={presentOrderStatus(item.status).tone}
                    label={presentOrderStatus(item.status).label}
                  />
                  <UnreadBadge
                    count={item.unreadMessageCount}
                    accessibilityLabel={CONVERSATION_COPY.unread(item.unreadMessageCount)}
                  />
                </View>
              }
              onPress={() => {
                onSelect(item);
              }}
            />
            {index < section.data.length - 1 && <Divider />}
          </View>
        )}
      />
    </View>
  );
}
