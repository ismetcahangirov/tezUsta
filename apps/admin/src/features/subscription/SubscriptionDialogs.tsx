import type { AdminSubscription, AdminSubscriptionPriceVersion } from '@tezusta/types';
import { type FormEvent, type ReactNode, useState } from 'react';

import { type ApiFailure, describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { TextField } from '../../components/TextField';
import { formatDateTime } from '../../format';
import { formatAzn, parseAznToMinor } from '../catalogue/money';
import {
  useCancelSubscriptionMutation,
  useChangeSubscriptionPricesMutation,
  useGrantSubscriptionMutation,
  useUpdateSubscriptionSettingsMutation,
  useWithdrawSubscriptionPriceMutation,
} from './api';
import { subscriptionCopy as text } from './copy';

export function errorMessage(failure: ApiFailure | undefined): string | undefined {
  if (failure === undefined) return undefined;
  if (failure.status === 403) return text.errors.FORBIDDEN;
  const code = failure.code;
  if (code !== undefined && code in text.errors) {
    return text.errors[code as keyof typeof text.errors];
  }
  return text.errors.unexpected;
}

/** A whole number in `[min, max]`, or undefined for anything else. */
function parseWholeNumber(value: string, min: number, max: number): number | undefined {
  if (!/^\d{1,3}$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : undefined;
}

/** The reason every edit carries, and its validation. */
function useReason() {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = reasonProblem(reason);
  const error =
    touched && problem !== undefined
      ? problem === 'empty'
        ? text.reasonEmpty
        : text.reasonTooLong
      : undefined;
  return { reason, setReason, problem, error, touch: () => setTouched(true) };
}

function DialogForm({
  title,
  body,
  busy,
  failure,
  submitLabel,
  danger = false,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  body: string;
  busy: boolean;
  failure: string | undefined;
  submitLabel: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <p className="text-body text-text">{body}</p>
        {children}
        {failure !== undefined && <Banner tone="danger" message={failure} />}
        <div className="flex justify-end gap-3">
          <Button label={text.cancel} variant="secondary" disabled={busy} onClick={onClose} />
          <Button
            type="submit"
            label={submitLabel}
            loadingLabel={text.saving}
            loading={busy}
            variant={danger ? 'primary' : 'accent'}
          />
        </div>
      </form>
    </Modal>
  );
}

/**
 * Both prices in one dialog. An empty field keeps that period's price. The
 * large-change confirmation appears only once the server asks for it, so the
 * common case is not slowed by a box nobody reads.
 */
export function PricesDialog({
  offer,
  onClose,
  onDone,
}: {
  offer: AdminSubscription;
  onClose: () => void;
  onDone: () => void;
}) {
  const [monthly, setMonthly] = useState('');
  const [yearly, setYearly] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [checked, setChecked] = useState(false);
  const reason = useReason();
  const [change, { isLoading, error, reset }] = useChangeSubscriptionPricesMutation();
  const failure = describeFailure(error);
  const askedToConfirm = failure?.code === 'SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED';

  const parse = (value: string) => (value.trim() === '' ? undefined : parseAznToMinor(value));
  const monthlyParsed = parse(monthly);
  const yearlyParsed = parse(yearly);
  const nothing = monthlyParsed === undefined && yearlyParsed === undefined;
  const fieldError = (parsed: ReturnType<typeof parse>) =>
    checked && parsed !== undefined && !parsed.ok ? text.pricesDialog.badAmount : undefined;

  async function submit() {
    setChecked(true);
    reason.touch();
    if (
      nothing ||
      monthlyParsed?.ok === false ||
      yearlyParsed?.ok === false ||
      reason.problem !== undefined
    ) {
      return;
    }
    const result = await change({
      ...(monthlyParsed?.ok === true ? { monthlyMinor: monthlyParsed.minor } : {}),
      ...(yearlyParsed?.ok === true ? { yearlyMinor: yearlyParsed.minor } : {}),
      ...(effectiveFrom === '' ? {} : { effectiveFrom: new Date(effectiveFrom).toISOString() }),
      ...(confirmLarge ? { confirmLargeChange: true } : {}),
      reason: reason.reason.trim(),
    });
    if (result.error === undefined) onDone();
  }

  const edited = () => {
    if (failure !== undefined && !askedToConfirm) reset();
  };

  return (
    <DialogForm
      title={text.pricesDialog.title}
      body={text.pricesDialog.body}
      busy={isLoading}
      failure={checked && nothing ? text.pricesDialog.nothingChanged : errorMessage(failure)}
      submitLabel={text.pricesDialog.submit}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={text.pricesDialog.monthly}
        hint={
          offer.monthly === null
            ? text.pricesDialog.unchangedHint
            : `${formatAzn(offer.monthly.priceMinor)} · ${text.pricesDialog.unchangedHint}`
        }
        inputMode="decimal"
        value={monthly}
        error={fieldError(monthlyParsed)}
        disabled={isLoading}
        onChange={(event) => {
          setMonthly(event.target.value);
          edited();
        }}
      />
      <TextField
        label={text.pricesDialog.yearly}
        hint={
          offer.yearly === null
            ? text.pricesDialog.unchangedHint
            : `${formatAzn(offer.yearly.priceMinor)} · ${text.pricesDialog.unchangedHint}`
        }
        inputMode="decimal"
        value={yearly}
        error={fieldError(yearlyParsed)}
        disabled={isLoading}
        onChange={(event) => {
          setYearly(event.target.value);
          edited();
        }}
      />
      <TextField
        label={text.pricesDialog.effectiveFrom}
        hint={text.pricesDialog.effectiveFromHint(offer.priceChangeNoticeDays)}
        type="datetime-local"
        value={effectiveFrom}
        disabled={isLoading}
        onChange={(event) => {
          setEffectiveFrom(event.target.value);
          edited();
        }}
      />
      {(askedToConfirm || confirmLarge) && (
        <Checkbox
          label={text.pricesDialog.confirmLarge}
          checked={confirmLarge}
          disabled={isLoading}
          onChange={(event) => setConfirmLarge(event.target.checked)}
        />
      )}
      <ReasonField
        label={text.reasonLabel}
        hint={text.reasonHint}
        value={reason.reason}
        error={reason.error}
        disabled={isLoading}
        onChange={(value) => {
          reason.setReason(value);
          edited();
        }}
      />
    </DialogForm>
  );
}

export function SettingsDialog({
  offer,
  onClose,
  onDone,
}: {
  offer: AdminSubscription;
  onClose: () => void;
  onDone: () => void;
}) {
  const [trial, setTrial] = useState(String(offer.trialDays));
  const [grace, setGrace] = useState(String(offer.graceDays));
  const [purchasesOpen, setPurchasesOpen] = useState(offer.purchasesOpen);
  const [checked, setChecked] = useState(false);
  const reason = useReason();
  const [update, { isLoading, error, reset }] = useUpdateSubscriptionSettingsMutation();

  const trialDays = parseWholeNumber(trial, 0, 90);
  const graceDays = parseWholeNumber(grace, 0, 30);

  async function submit() {
    setChecked(true);
    reason.touch();
    if (trialDays === undefined || graceDays === undefined || reason.problem !== undefined) return;
    const result = await update({
      trialDays,
      graceDays,
      purchasesOpen,
      reason: reason.reason.trim(),
    });
    if (result.error === undefined) onDone();
  }

  return (
    <DialogForm
      title={text.settingsDialog.title}
      body={text.settingsDialog.body}
      busy={isLoading}
      failure={errorMessage(describeFailure(error))}
      submitLabel={text.settingsDialog.submit}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={text.settingsDialog.trialDays}
        inputMode="numeric"
        value={trial}
        error={checked && trialDays === undefined ? text.settingsDialog.badTrial : undefined}
        disabled={isLoading}
        onChange={(event) => {
          setTrial(event.target.value);
          reset();
        }}
      />
      <TextField
        label={text.settingsDialog.graceDays}
        inputMode="numeric"
        value={grace}
        error={checked && graceDays === undefined ? text.settingsDialog.badGrace : undefined}
        disabled={isLoading}
        onChange={(event) => {
          setGrace(event.target.value);
          reset();
        }}
      />
      <Checkbox
        label={text.settingsDialog.purchasesOpen}
        checked={purchasesOpen}
        disabled={isLoading}
        onChange={(event) => {
          setPurchasesOpen(event.target.checked);
          reset();
        }}
      />
      <ReasonField
        label={text.reasonLabel}
        hint={text.reasonHint}
        value={reason.reason}
        error={reason.error}
        disabled={isLoading}
        onChange={(value) => {
          reason.setReason(value);
          reset();
        }}
      />
    </DialogForm>
  );
}

export function WithdrawDialog({
  price,
  onClose,
  onDone,
}: {
  price: AdminSubscriptionPriceVersion;
  onClose: () => void;
  onDone: () => void;
}) {
  const reason = useReason();
  const [withdraw, { isLoading, error, reset }] = useWithdrawSubscriptionPriceMutation();

  async function submit() {
    reason.touch();
    if (reason.problem !== undefined) return;
    const result = await withdraw({ priceId: price.id, reason: reason.reason.trim() });
    if (result.error === undefined) onDone();
  }

  return (
    <DialogForm
      title={text.withdrawDialog.title}
      body={text.withdrawDialog.body(
        text.period[price.billingPeriod],
        price.priceMinor === null ? text.none : formatAzn(price.priceMinor),
        formatDateTime(price.effectiveFrom),
      )}
      busy={isLoading}
      failure={errorMessage(describeFailure(error))}
      submitLabel={text.withdrawDialog.submit}
      danger
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <ReasonField
        label={text.reasonLabel}
        hint={text.reasonHint}
        value={reason.reason}
        error={reason.error}
        disabled={isLoading}
        onChange={(value) => {
          reason.setReason(value);
          reset();
        }}
      />
    </DialogForm>
  );
}

export function GrantDialog({
  masterId,
  masterName,
  onClose,
  onDone,
}: {
  masterId: string;
  masterName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [days, setDays] = useState('');
  const [checked, setChecked] = useState(false);
  const reason = useReason();
  const [grant, { isLoading, error, reset }] = useGrantSubscriptionMutation();
  const parsed = parseWholeNumber(days, 1, 366);

  async function submit() {
    setChecked(true);
    reason.touch();
    if (parsed === undefined || reason.problem !== undefined) return;
    const result = await grant({ masterId, days: parsed, reason: reason.reason.trim() });
    if (result.error === undefined) onDone();
  }

  return (
    <DialogForm
      title={text.master.grantDialog.title}
      body={text.master.grantDialog.body(masterName)}
      busy={isLoading}
      failure={errorMessage(describeFailure(error))}
      submitLabel={text.master.grantDialog.submit}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <TextField
        label={text.master.grantDialog.days}
        inputMode="numeric"
        value={days}
        error={checked && parsed === undefined ? text.master.grantDialog.badDays : undefined}
        disabled={isLoading}
        onChange={(event) => {
          setDays(event.target.value);
          reset();
        }}
      />
      <ReasonField
        label={text.reasonLabel}
        hint={text.reasonHint}
        value={reason.reason}
        error={reason.error}
        disabled={isLoading}
        onChange={(value) => {
          reason.setReason(value);
          reset();
        }}
      />
    </DialogForm>
  );
}

export function CancelSubscriptionDialog({
  masterId,
  masterName,
  onClose,
  onDone,
}: {
  masterId: string;
  masterName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const reason = useReason();
  const [cancel, { isLoading, error, reset }] = useCancelSubscriptionMutation();

  async function submit() {
    reason.touch();
    if (reason.problem !== undefined) return;
    const result = await cancel({ masterId, reason: reason.reason.trim() });
    if (result.error === undefined) onDone();
  }

  return (
    <DialogForm
      title={text.master.cancelDialog.title}
      body={text.master.cancelDialog.body(masterName)}
      busy={isLoading}
      failure={errorMessage(describeFailure(error))}
      submitLabel={text.master.cancelDialog.submit}
      danger
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <ReasonField
        label={text.reasonLabel}
        hint={text.reasonHint}
        value={reason.reason}
        error={reason.error}
        disabled={isLoading}
        onChange={(value) => {
          reason.setReason(value);
          reset();
        }}
      />
    </DialogForm>
  );
}
