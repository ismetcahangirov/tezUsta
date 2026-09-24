import { skipToken } from '@reduxjs/toolkit/query';
import type { MasterJob } from '@tezusta/types';
import { useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';

import { formatAddressDetail } from '../addresses/format-address-detail';
import { canCallAbout } from '../calls/call-availability';
import { CallEntry } from '../calls/CallEntry';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Sheet,
  Skeleton,
  StatusPill,
  Text,
  TextField,
} from '../components';
import { useConversationQuery } from '../conversation/conversation-endpoints';
import { ConversationEntry } from '../conversation/ConversationEntry';
import { deviceLocale } from '../lib/device-locale';
import { formatOrderPrice } from '../orders/format-order-price';
import { OrderReviewPrompt, useOrderReviewsQuery } from '../reviews';
import { useGetServiceQuery } from '../service-catalogue/service-catalogue-endpoints';
import { useAppSelector } from '../store/hooks';
import { jobStepFor } from './job-steps';
import { selectLastJobOrderId } from './last-job-slice';
import { useCurrentJobQuery, useTransitionJobMutation } from './master-jobs-endpoints';
import { MASTER_JOBS_COPY } from './master-jobs-copy';
import { useMasterWork } from './master-work-context';

const copy = MASTER_JOBS_COPY.job;

/**
 * The hand-off to a maps application (EPIC 9: turn-by-turn is out of scope).
 *
 * Google's cross-platform directions URL, because the product's maps provider
 * is Google Maps Platform (ADR-0004): it opens the Google Maps app where one is
 * installed and the browser where not, on both platforms, with no key. The
 * coordinates leave the app only because the master asked to navigate to them.
 */
export function directionsUrl(job: Pick<MasterJob, 'address'>): string {
  const { latitude, longitude } = job.address;
  return `https://www.google.com/maps/dir/?api=1&destination=${String(latitude)},${String(longitude)}`;
}

export interface JobDetailProps {
  readonly onBack: () => void;
  /**
   * Opens the job's conversation, pushed over this screen (issue #182). Absent
   * in tests of the rest of the screen, which then show no entry.
   */
  readonly onOpenConversation?: ((orderId: string) => void) | undefined;
  /**
   * Opens the review of a job this master has just completed (issue #227).
   * Absent, the completed state shows no prompt.
   */
  readonly onOpenReview?: ((orderId: string) => void) | undefined;
}

/**
 * The job the master is on, and the one thing they can do next (issue #199).
 *
 * **Read from `GET /masters/me/jobs/current`, not from a route parameter.** A
 * master has at most one job (`orders_one_active_per_master`), so the screen
 * has nothing to be told — and a route that took an order id would be a way
 * to render an order the server no longer says is theirs. When the read
 * answers `null` — the customer cancelled, the job was completed, it was
 * handed back — the screen says so plainly instead of holding a stale job.
 *
 * **One forward button, from `jobStepFor`.** The master walks the order one
 * status at a time, as the transition table allows; the server re-checks every
 * tap, and a refusal re-reads the job rather than guessing what happened.
 */
export function JobDetail({
  onBack,
  onOpenConversation,
  onOpenReview,
}: JobDetailProps): React.JSX.Element {
  const job = useCurrentJobQuery();
  const [transition, transitionResult] = useTransitionJobMutation();
  const [handingBack, setHandingBack] = useState(false);
  const [failed, setFailed] = useState(false);
  const { reporter, backgroundDenied } = useMasterWork();

  const current = job.currentData?.job;

  /**
   * The master's unread count, from the conversation itself (issue #182). One
   * request for the one job this screen shows — the job read lives in the
   * masters module and does not carry it — and the socket keeps it current by
   * patching this same entry as messages arrive.
   */
  const conversation = useConversationQuery(
    current === undefined || current === null ? skipToken : current.orderId,
  );

  /**
   * The job this screen was showing, once the read has let go of it (issue
   * #227). A completed job is the one case where "no longer yours" is the
   * wrong thing to say: the master has just finished it, and ADR-0042 § 1 puts
   * the review prompt here. The order's reviews tell the two apart without a
   * guess — `windowClosesAt` is set exactly when the order reached
   * `COMPLETED`, and a cancelled job, or one handed back, has none.
   */
  const lastOrderId = useAppSelector(selectLastJobOrderId);
  const finished = useOrderReviewsQuery(
    current === null && lastOrderId !== null ? lastOrderId : skipToken,
  );

  if (current === undefined) {
    return (
      <JobFrame onBack={onBack}>
        {job.error === undefined ? (
          <View accessible accessibilityLabel={copy.title} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : (
          <EmptyState
            title={copy.loadFailed}
            action={
              <Button
                label={copy.retry}
                loading={job.isFetching}
                onPress={() => {
                  void job.refetch();
                }}
              />
            }
          />
        )}
      </JobFrame>
    );
  }

  if (current === null && lastOrderId !== null && finished.isLoading) {
    return (
      <JobFrame onBack={onBack}>
        <View accessible accessibilityLabel={copy.title} className="gap-4">
          <Skeleton className="h-control-lg w-full" />
        </View>
      </JobFrame>
    );
  }

  if (
    current === null &&
    lastOrderId !== null &&
    typeof finished.currentData?.windowClosesAt === 'string'
  ) {
    return (
      <JobFrame onBack={onBack}>
        <View className="gap-4">
          <EmptyState title={copy.completedTitle} description={copy.completedDescription} />
          {onOpenReview !== undefined && (
            <OrderReviewPrompt orderId={lastOrderId} viewer="master" onPress={onOpenReview} />
          )}
          <Button label={copy.toHome} variant="secondary" fullWidth onPress={onBack} />
        </View>
      </JobFrame>
    );
  }

  if (current === null) {
    return (
      <JobFrame onBack={onBack}>
        <EmptyState
          title={copy.goneTitle}
          description={copy.goneDescription}
          action={<Button label={copy.toHome} onPress={onBack} />}
        />
      </JobFrame>
    );
  }

  const step = jobStepFor(current.status);
  const next = step?.next ?? null;
  const nextLabel = next === null ? undefined : copy.advance[next as keyof typeof copy.advance];

  return (
    <JobFrame onBack={onBack}>
      <ScrollView className="flex-1">
        <View className="gap-4 pb-10">
          {failed && <Banner tone="danger" message={copy.transitionFailed} />}
          {reporter.stale && (
            <Banner tone="danger" message={MASTER_JOBS_COPY.reporting.staleDescription} />
          )}
          {backgroundDenied && <Banner message={MASTER_JOBS_COPY.reporting.backgroundDenied} />}

          <JobSummary job={current} />

          {onOpenConversation !== undefined && (
            <ConversationEntry
              viewer="master"
              unreadCount={conversation.currentData?.unreadCount ?? 0}
              writable={conversation.currentData?.writable ?? true}
              onPress={() => {
                onOpenConversation(current.orderId);
              }}
            />
          )}

          {next !== null && nextLabel !== undefined && (
            <Button
              label={nextLabel}
              variant="accent"
              size="lg"
              fullWidth
              loading={transitionResult.isLoading}
              onPress={() => {
                setFailed(false);
                void transition({ orderId: current.orderId, to: next })
                  .unwrap()
                  .catch(() => {
                    setFailed(true);
                  });
              }}
            />
          )}

          {step?.canHandBack === true && !handingBack && (
            <Button
              label={copy.handBack}
              variant="ghost"
              fullWidth
              disabled={transitionResult.isLoading}
              onPress={() => {
                setHandingBack(true);
              }}
            />
          )}

          {handingBack && (
            <HandBackSheet
              busy={transitionResult.isLoading}
              onCancel={() => {
                setHandingBack(false);
              }}
              onConfirm={(reason) => {
                setFailed(false);
                void transition({ orderId: current.orderId, to: 'SEARCHING', reason })
                  .unwrap()
                  .then(() => {
                    setHandingBack(false);
                  })
                  .catch(() => {
                    setHandingBack(false);
                    setFailed(true);
                  });
              }}
            />
          )}
        </View>
      </ScrollView>
    </JobFrame>
  );
}

function JobSummary({ job }: { readonly job: MasterJob }): React.JSX.Element {
  const service = useGetServiceQuery({ id: job.serviceId, locale: deviceLocale() });
  const statusLabel = copy.status[job.status as keyof typeof copy.status];
  const detail = formatAddressDetail(job.address);

  return (
    <Card className="gap-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="body-strong" className="flex-1">
          {service.currentData?.name ?? ''}
        </Text>
        {statusLabel !== undefined && <StatusPill status="active" label={statusLabel} />}
        {/* Nothing unless callable and calling is on (ADR-0040 § 6, ADR-0039 § 3). */}
        <CallEntry orderId={job.orderId} viewer="master" available={canCallAbout(job)} />
      </View>

      <View className="gap-1">
        <Text variant="caption" tone="muted">
          {copy.address}
        </Text>
        <Text variant="body">{job.address.formattedAddress}</Text>
        {detail !== '' && (
          <Text variant="caption" tone="muted">
            {detail}
          </Text>
        )}
        <Button
          label={copy.openInMaps}
          variant="secondary"
          size="sm"
          onPress={() => {
            void Linking.openURL(directionsUrl(job)).catch(() => {
              // No browser and no maps app is not something this screen can
              // fix; the address is on screen above the button.
            });
          }}
        />
      </View>

      <View className="gap-1">
        <Text variant="caption" tone="muted">
          {copy.problem}
        </Text>
        <Text variant="body">{job.description}</Text>
      </View>

      <View className="gap-1">
        <Text variant="caption" tone="muted">
          {copy.price}
        </Text>
        <Text variant="body-strong">
          {job.priceMinor === null ? copy.priceOnSite : formatOrderPrice(job.priceMinor)}
        </Text>
      </View>
    </Card>
  );
}

interface HandBackSheetProps {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

/**
 * "I can't come", behind a confirmation and a reason.
 *
 * The reason is required by the server for a re-dispatch (#136) — it is the
 * customer's only explanation of why their master turned round — so the
 * confirm button refuses an empty one here rather than letting the server's
 * 422 be the first the master hears of it.
 */
function HandBackSheet({ busy, onCancel, onConfirm }: HandBackSheetProps): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const trimmed = reason.trim();

  return (
    <Sheet title={copy.handBackTitle} className="rounded-md">
      <Text variant="body" tone="muted">
        {copy.handBackDescription}
      </Text>
      <TextField
        label={copy.handBackReason}
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={600}
        {...(touched && trimmed === '' ? { error: copy.handBackReasonRequired } : {})}
      />
      <View className="flex-row gap-3">
        <Button
          label={copy.handBackCancel}
          variant="secondary"
          disabled={busy}
          onPress={onCancel}
          className="flex-1"
        />
        <Button
          label={copy.handBackConfirm}
          variant="danger"
          loading={busy}
          onPress={() => {
            setTouched(true);
            if (trimmed !== '') {
              onConfirm(trimmed);
            }
          }}
          className="flex-1"
        />
      </View>
    </Sheet>
  );
}

interface JobFrameProps {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}

function JobFrame({ onBack, children }: JobFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 p-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1">{copy.title}</Text>
        <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}
