import type { OwnReport, ReportableParty, ReportReasonCode } from '@tezusta/types';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';

import {
  Banner,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  ListRow,
  Skeleton,
  Text,
  TextField,
} from '../components';
import { REPORTS_COPY as copy } from './report-copy';
import {
  useEditReportMutation,
  useReportPartiesQuery,
  useSubmitReportMutation,
} from './report-endpoints';

/** The longest text the API accepts (`submitReportSchema`, ADR-0053 § 2). */
export const MAX_REPORT_TEXT_LENGTH = 1000;

const REASONS = Object.keys(copy.reason) as ReportReasonCode[];

/** `KeyboardAvoidingView` takes no `className`; its one rule is the absence of a size. */
const FILL = { flex: 1 } as const;

type Failure = keyof typeof copy.failure;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const { data } = error as { data?: unknown };
  if (typeof data !== 'object' || data === null || !('error' in data)) return undefined;
  const code = (data as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : undefined;
}

function failureOf(error: unknown): Failure {
  switch (codeOf(error)) {
    case 'REPORT_WINDOW_CLOSED':
      return 'closed';
    case 'REPORT_NOT_EDITABLE':
      return 'notEditable';
    case 'REPORT_ALREADY_FILED':
      return 'duplicate';
    default:
      return 'unexpected';
  }
}

/**
 * The party the form opens on: one with a report still open to edit, else the
 * current one while open, else any still open, else one already reported —
 * so the entry's "Problem bildirildi" opens on that report.
 */
function initialParty(parties: readonly ReportableParty[]): ReportableParty | undefined {
  return (
    parties.find((party) => party.open && party.report?.editable === true) ??
    parties.find((party) => party.current && party.open) ??
    parties.find((party) => party.open) ??
    parties.find((party) => party.report !== null) ??
    parties[0]
  );
}

export interface OrderReportProps {
  readonly orderId: string;
  readonly onBack: () => void;
  /** After the server accepted a submit or an edit — the route pops back. */
  readonly onDone: () => void;
}

/**
 * Report the other party on one order (#330, ADR-0053). Laid out by
 * delegation from the design system's own components; the copy is a
 * placeholder for the owner.
 *
 * **Told the order id and nothing else.** Who may be reported, whether that is
 * still possible, and the caller's own report all come from
 * `GET /orders/:id/reports/parties`.
 *
 * **One party, or a choice.** A master reports the customer. A customer whose
 * order has had more than one master — one who gave the job up — chooses
 * which; with one, there is nothing to choose.
 */
export function OrderReport({ orderId, onBack, onDone }: OrderReportProps): React.JSX.Element {
  const parties = useReportPartiesQuery(orderId);
  const current = parties.currentData;
  const [chosen, setChosen] = useState<string | null>(null);

  if (current === undefined) {
    return (
      <ReportFrame onBack={onBack}>
        {parties.error === undefined ? (
          <View accessible accessibilityLabel={copy.loading} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : (
          <EmptyState
            title={copy.errorTitle}
            description={copy.errorDescription}
            action={
              <Button
                label={copy.retry}
                loading={parties.isFetching}
                onPress={() => {
                  void parties.refetch();
                }}
              />
            }
          />
        )}
      </ReportFrame>
    );
  }

  const reportable = current.filter((party) => party.open || party.report !== null);
  const party =
    reportable.find((candidate) => candidate.profileId === chosen) ?? initialParty(reportable);

  return (
    <KeyboardAvoidingView behavior="padding" style={FILL}>
      <ReportFrame onBack={onBack}>
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
          <View className="gap-6 pb-10">
            {party === undefined ? (
              <EmptyState title={copy.unavailableTitle} description={copy.unavailableDescription} />
            ) : (
              <>
                {reportable.length > 1 && (
                  <View className="gap-2">
                    <Text variant="h2">{copy.whoLabel}</Text>
                    <Card className="px-4">
                      {reportable.map((candidate) => {
                        const selected = candidate.profileId === party.profileId;
                        const subtitle = candidate.current ? copy.whoCurrent : copy.whoLeft;
                        return (
                          <ListRow
                            key={candidate.profileId}
                            title={candidate.displayName}
                            subtitle={subtitle}
                            accessibilityLabel={`${candidate.displayName}, ${subtitle}${selected ? `, ${copy.selected}` : ''}`}
                            trailing={selected ? <CheckIcon tone="text" /> : undefined}
                            onPress={() => {
                              setChosen(candidate.profileId);
                            }}
                          />
                        );
                      })}
                    </Card>
                  </View>
                )}

                {party.report !== null && (!party.report.editable || !party.open) ? (
                  // Read-only once claimed — or once the window closed, when
                  // a save could only be refused.
                  <SentReport report={party.report} />
                ) : (
                  <ReportForm
                    // A fresh form per party, and per version of its report.
                    key={`${party.profileId}:${party.report?.updatedAt ?? 'new'}`}
                    orderId={orderId}
                    party={party}
                    choosesMaster={party.role === 'master'}
                    onDone={onDone}
                  />
                )}
              </>
            )}
          </View>
        </ScrollView>
      </ReportFrame>
    </KeyboardAvoidingView>
  );
}

interface ReportFormProps {
  readonly orderId: string;
  readonly party: ReportableParty;
  /**
   * Whether the request names the master: always, for a customer, so the
   * report is about the master on screen and never the server's default.
   */
  readonly choosesMaster: boolean;
  readonly onDone: () => void;
}

/**
 * A reason from the list, optional words, one button. The reason is required;
 * a press without one says so rather than sending what the server refuses.
 */
function ReportForm({ orderId, party, choosesMaster, onDone }: ReportFormProps): React.JSX.Element {
  const existing = party.report;
  const [reason, setReason] = useState<ReportReasonCode | null>(existing?.reasonCode ?? null);
  const [text, setText] = useState(existing?.text ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submit, submitResult] = useSubmitReportMutation();
  const [edit, editResult] = useEditReportMutation();
  const busy = submitResult.isLoading || editResult.isLoading;
  const count = Array.from(text).length;

  return (
    <View className="gap-6">
      {failure !== null && <Banner tone="danger" message={copy.failure[failure]} />}
      {existing !== null && <Banner message={copy.editableNotice} />}

      <View className="gap-2">
        <Text variant="h2">{copy.reasonLabel}</Text>
        <Card className="px-4">
          {REASONS.map((option) => {
            const selected = option === reason;
            return (
              <ListRow
                key={option}
                title={copy.reason[option]}
                accessibilityLabel={`${copy.reason[option]}${selected ? `, ${copy.selected}` : ''}`}
                trailing={selected ? <CheckIcon tone="text" /> : undefined}
                onPress={() => {
                  setReason(option);
                }}
              />
            );
          })}
        </Card>
        {touched && reason === null && (
          <Text variant="footnote" tone="danger">
            {copy.reasonRequired}
          </Text>
        )}
      </View>

      <View className="gap-1">
        <TextField
          label={copy.textLabel}
          placeholder={copy.textPlaceholder}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={MAX_REPORT_TEXT_LENGTH}
          editable={!busy}
        />
        <Text
          variant="footnote"
          tone="muted"
          className="self-end"
          accessibilityLabel={copy.textCountLabel(count, MAX_REPORT_TEXT_LENGTH)}
        >
          {copy.textCount(count, MAX_REPORT_TEXT_LENGTH)}
        </Text>
      </View>

      <Text variant="caption" tone="muted">
        {copy.privacyNote}
      </Text>

      <Button
        label={existing === null ? copy.submit : copy.save}
        variant="accent"
        size="lg"
        fullWidth
        loading={busy}
        onPress={() => {
          setTouched(true);
          if (reason === null) return;
          setFailure(null);
          const trimmed = text.trim();
          const body = {
            orderId,
            reasonCode: reason,
            text: trimmed === '' ? null : trimmed,
            ...(choosesMaster ? { masterId: party.profileId } : {}),
          };
          const write = existing === null ? submit(body) : edit(body);
          void write
            .unwrap()
            .then(() => {
              onDone();
            })
            .catch((error: unknown) => {
              setFailure(failureOf(error));
            });
        }}
      />
    </View>
  );
}

/** A report nobody may change any more: being handled, or handled. Its words as text only. */
function SentReport({ report }: { report: OwnReport }): React.JSX.Element {
  return (
    <View className="gap-3">
      <Banner
        message={
          report.status === 'closed'
            ? copy.closedNotice
            : report.editable
              ? copy.windowClosedNotice
              : copy.inReviewNotice
        }
      />
      <Card className="gap-3">
        <Text variant="caption" tone="muted">
          {copy.sentTitle} · {copy.status[report.status]}
        </Text>
        <Text variant="body-strong">{copy.reason[report.reasonCode]}</Text>
        <Text variant="body" tone={report.text === null ? 'muted' : 'default'}>
          {report.text ?? copy.noText}
        </Text>
      </Card>
    </View>
  );
}

/** The title row every state shares, so back is reachable from all of them. */
function ReportFrame({
  onBack,
  children,
}: {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
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
