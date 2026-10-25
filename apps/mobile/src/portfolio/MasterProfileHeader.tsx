import type { MasterPublicProfile } from '@tezusta/types';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Avatar, Card, ListRow, PencilIcon, Text } from '../components';
import { formatOrderPrice } from '../orders/format-order-price';
import { PartyRatingLine } from '../reviews/PartyRatingLine';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';

/** A longer bio ends with "Daha çox" (ADR-0054 § 1). */
export const BIO_MAX_LINES = 4;

export interface MasterProfileHeaderProps {
  readonly profile: Pick<
    MasterPublicProfile,
    'displayName' | 'bio' | 'avatarLargeUrl' | 'rating' | 'services'
  >;
  /**
   * The master's own profile only: the avatar becomes a control, with a pencil
   * mark at its bottom right (ADR-0054 § 7).
   */
  readonly onEditAvatar?: () => void;
  /** Under the rating: the avatar's progress on the master's own profile (ADR-0054 § 7). */
  readonly belowName?: React.ReactNode;
  /**
   * The master's own profile only: "Xidmətləri idarə et" at the foot of the
   * Services card (ADR-0063). Given, the card is drawn even with no services,
   * because it is then the only way to add the first one.
   */
  readonly servicesAction?: React.ReactNode;
}

/**
 * The top of the master's profile (ADR-0054 § 1): who they are, how they are
 * rated, what they say about themselves and what they charge. On the page, not
 * in a card; the services are the one card.
 *
 * The screen's own parts are not here: its header row, the "İşlər" heading
 * and the master's "Yeni paylaşım" button (#314, #315).
 */
export function MasterProfileHeader({
  profile,
  onEditAvatar,
  belowName,
  servicesAction,
}: MasterProfileHeaderProps): React.JSX.Element {
  const avatar = (
    <Avatar
      name={profile.displayName}
      {...(profile.avatarLargeUrl === null ? {} : { uri: profile.avatarLargeUrl })}
      size="lg"
    />
  );

  return (
    <View className="gap-6">
      <View className="gap-4">
        <View className="flex-row items-center gap-4">
          {onEditAvatar === undefined ? (
            avatar
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.avatar.change}
              onPress={onEditAvatar}
              className="active:opacity-80"
            >
              {/* The control's label says what it does; the avatar's own name would repeat the heading. */}
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {avatar}
              </View>
              {/*
               * The pencil mark (ADR-0054 § 7): `on-inverse` on an
               * `inverse-surface` circle. Not pinned: in the dark palette it is
               * a white circle with a dark pencil, which reads on the dark page.
               */}
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="absolute bottom-0 right-0 h-6 w-6 items-center justify-center rounded-full bg-inverse-surface"
              >
                <PencilIcon size="sm" tone="on-inverse" />
              </View>
            </Pressable>
          )}
          <View className="flex-1 gap-1">
            <Text variant="h1" numberOfLines={2} accessibilityRole="header">
              {profile.displayName}
            </Text>
            <PartyRatingLine label={copy.profile.ratingLabel} rating={profile.rating} labelHidden />
            {belowName}
          </View>
        </View>
        {profile.bio !== null && <Bio text={profile.bio} />}
      </View>

      {(profile.services.length > 0 || servicesAction !== undefined) && (
        <Card className="gap-2">
          <Text variant="h2" accessibilityRole="header">
            {copy.profile.servicesTitle}
          </Text>
          {profile.services.map((service) => (
            <ListRow
              key={service.serviceId}
              title={service.name}
              trailing={
                <Text variant="body-strong">
                  {service.priceMinor === null
                    ? copy.profile.priceAfterInspection
                    : formatOrderPrice(service.priceMinor)}
                </Text>
              }
            />
          ))}
          {profile.services.length === 0 && (
            <Text variant="caption" tone="muted">
              {copy.own.noServices}
            </Text>
          )}
          {servicesAction}
        </Card>
      )}
    </View>
  );
}

/**
 * The bio, at most four lines, with "Daha çox" when it is longer.
 *
 * **Whether it is longer is measured, not guessed.** A hidden copy of the
 * whole bio, laid out at the same width without a line limit, reports its
 * line count; the visible copy is clamped. Counting characters would be wrong
 * for every font size and screen width. React Native Web does not report
 * lines, so in Storybook the bio clamps and the button stays hidden.
 */
function Bio({ text }: { readonly text: string }): React.JSX.Element {
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  return (
    <View className="gap-1">
      <View>
        <Text
          variant="body"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="absolute left-0 right-0 top-0 opacity-0"
          onTextLayout={(event) => {
            setOverflows(event.nativeEvent.lines.length > BIO_MAX_LINES);
          }}
        >
          {text}
        </Text>
        <Text variant="body" numberOfLines={expanded ? undefined : BIO_MAX_LINES}>
          {text}
        </Text>
      </View>
      {overflows && !expanded && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setExpanded(true);
          }}
          className="min-h-touch-target justify-center self-start active:opacity-80"
        >
          <Text variant="body-strong">{copy.profile.bioMore}</Text>
        </Pressable>
      )}
    </View>
  );
}
