import type { AdminAccountRecovery } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { type ApiFailure, describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import {
  useApproveRecoveryMutation,
  useCancelRecoveryMutation,
  useRecoveryQuery,
  useResendRecoveryCodeMutation,
  useVerifyRecoveryMutation,
} from './api';
import { recoveriesCopy, recoveryErrorMessage } from './copy';
import { ReasonDialog, RevealEmailsDialog } from './RecoveryDialogs';
import { RecoveryPhotos } from './RecoveryPhotos';
import { adminName, approveBlocker, canApprove, holdLeft, isOpen } from './rules';

const LINK_CLASS =
  'font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus';

/** Shape only, as the API checks it: the length is the server's to know. */
const CODE_SHAPE = /^\d{4,12}$/;

function BackLink() {
  return (
    <Link
      to="/recoveries"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {recoveriesCopy.back}
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body text-text">{children}</dd>
    </div>
  );
}

/** One recovery request (#517): its facts, the code step, and cancel and approve. */
export function RecoveryDetailPage() {
  const { id = '' } = useParams();
  const { data: recovery, error, isLoading, refetch } = useRecoveryQuery(id);
  const failure = describeFailure(error);

  if (recovery === undefined) {
    return (
      <PageFrame title={recoveriesCopy.title}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {recoveriesCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={recoveriesCopy.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={recoveriesCopy.detailLoadFailed} />
            <Button
              label={recoveriesCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )}
      </PageFrame>
    );
  }

  return <Recovery recovery={recovery} />;
}

type Pending = 'cancel' | 'approve' | 'reveal' | null;

function Recovery({ recovery }: { recovery: AdminAccountRecovery }) {
  const me = useSignedInAdmin();
  const [pending, setPending] = useState<Pending>(null);
  const [cancelRecovery] = useCancelRecoveryMutation();
  const [approveRecovery] = useApproveRecoveryMutation();
  const now = new Date();
  const open = isOpen(recovery);
  const approver = canApprove(me);
  const blocker = approver ? approveBlocker(me, recovery, now) : null;
  const canReveal = me.permissions.includes('pii.read');

  return (
    <PageFrame title={recovery.accountName ?? recoveriesCopy.unknownAccount}>
      <BackLink />
      <p className="text-body text-text">
        <span className="font-semibold">{recoveriesCopy.status[recovery.status]}</span>
        {recovery.status === 'cancelled' && recovery.cancelSource !== null && (
          <span className="text-text-muted">
            {' '}
            — {recoveriesCopy.cancelSource[recovery.cancelSource]}
          </span>
        )}
      </p>
      {recovery.status === 'moved' && <Banner message={recoveriesCopy.moved} />}

      {(open || canReveal) && (
        <div role="group" aria-label={recoveriesCopy.actions} className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-3">
            {open && approver && (
              <Button
                label={recoveriesCopy.approve}
                variant="accent"
                disabled={blocker !== null}
                aria-describedby={blocker === null ? undefined : 'approve-blocker'}
                onClick={() => setPending('approve')}
              />
            )}
            {open && (
              <Button
                label={recoveriesCopy.cancel}
                variant="secondary"
                onClick={() => setPending('cancel')}
              />
            )}
            {canReveal && (
              <Button
                label={recoveriesCopy.revealEmails}
                variant="secondary"
                onClick={() => setPending('reveal')}
              />
            )}
          </div>
          {open && !approver && (
            <p className="text-caption text-text-muted">{recoveriesCopy.approveOnlySuperAdmin}</p>
          )}
          {open && blocker !== null && (
            <p id="approve-blocker" className="text-caption text-text-muted">
              {blocker}
            </p>
          )}
        </div>
      )}

      {recovery.status === 'awaiting_code' && <CodeStep recoveryId={recovery.id} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 text-text">{recoveriesCopy.facts}</h2>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-3">
          <Fact label={recoveriesCopy.account}>
            <span className="flex flex-col gap-1">
              {recovery.customerId !== null && (
                <Link to={`/customers/${recovery.customerId}`} className={LINK_CLASS}>
                  {recoveriesCopy.openCustomer}
                </Link>
              )}
              {recovery.masterId !== null && (
                <Link to={`/masters/${recovery.masterId}`} className={LINK_CLASS}>
                  {recoveriesCopy.openMaster}
                </Link>
              )}
            </span>
          </Fact>
          <Fact label={recoveriesCopy.oldEmail}>{recovery.oldEmailMasked}</Fact>
          <Fact label={recoveriesCopy.newEmail}>{recovery.newEmailMasked}</Fact>
          <Fact label={recoveriesCopy.openedBy}>
            {adminName(me, recovery.openedByAdminId, recovery.openedByName)}
          </Fact>
          <Fact label={recoveriesCopy.openedAt}>{formatDateTime(recovery.openedAt)}</Fact>
          <Fact label={recoveriesCopy.codeVerifiedAt}>
            {recovery.codeVerifiedAt === null
              ? recoveriesCopy.none
              : formatDateTime(recovery.codeVerifiedAt)}
          </Fact>
          <Fact label={recoveriesCopy.holdUntil}>
            {recovery.holdUntil === null ? (
              recoveriesCopy.none
            ) : (
              <>
                {formatDateTime(recovery.holdUntil)}
                {holdLeft(recovery, now) !== null && (
                  <span className="text-caption text-text-muted"> ({holdLeft(recovery, now)})</span>
                )}
              </>
            )}
          </Fact>
          {recovery.cancelledAt !== null && (
            <>
              <Fact label={recoveriesCopy.cancelled}>{formatDateTime(recovery.cancelledAt)}</Fact>
              <Fact label={recoveriesCopy.cancelledBy}>
                {adminName(me, recovery.cancelledByAdminId, recovery.cancelledByName)}
              </Fact>
              <Fact label={recoveriesCopy.cancelReason}>
                {recovery.cancelReason ?? recoveriesCopy.none}
              </Fact>
            </>
          )}
          {recovery.movedAt !== null && (
            <>
              <Fact label={recoveriesCopy.movedAt}>{formatDateTime(recovery.movedAt)}</Fact>
              <Fact label={recoveriesCopy.approvedBy}>
                {adminName(me, recovery.approvedByAdminId, recovery.approvedByName)}
              </Fact>
            </>
          )}
        </dl>
      </section>

      {recovery.masterId !== null && <RecoveryPhotos recovery={recovery} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 text-text">{recoveriesCopy.evidence}</h2>
        <p className="whitespace-pre-wrap rounded-md border-hairline border-border bg-surface p-4 text-body text-text">
          {recovery.evidenceNotes}
        </p>
      </section>

      {pending === 'cancel' && (
        <ReasonDialog
          title={recoveriesCopy.cancelTitle}
          body={recoveriesCopy.cancelBody}
          hint={recoveriesCopy.cancelHint}
          submitLabel={recoveriesCopy.cancel}
          submittingLabel={recoveriesCopy.cancelling}
          onClose={() => setPending(null)}
          onDone={() => setPending(null)}
          onSubmit={async (reason) => failureOf(await cancelRecovery({ id: recovery.id, reason }))}
        />
      )}
      {pending === 'approve' && (
        <ReasonDialog
          title={recoveriesCopy.approveTitle}
          body={recoveriesCopy.approveBody}
          hint={recoveriesCopy.approveHint}
          submitLabel={recoveriesCopy.approve}
          submittingLabel={recoveriesCopy.approving}
          onClose={() => setPending(null)}
          onDone={() => setPending(null)}
          onSubmit={async (reason) => failureOf(await approveRecovery({ id: recovery.id, reason }))}
        />
      )}
      {pending === 'reveal' && (
        <RevealEmailsDialog recoveryId={recovery.id} onClose={() => setPending(null)} />
      )}
    </PageFrame>
  );
}

function failureOf(
  result: { data: unknown } | { error: Parameters<typeof describeFailure>[0] },
): ApiFailure | undefined {
  if ('data' in result) return undefined;
  return describeFailure(result.error) ?? { status: 'network', code: undefined };
}

/** The code the user reads back from the new address; right, it starts the hold. */
function CodeStep({ recoveryId }: { recoveryId: string }) {
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [verify, verifying] = useVerifyRecoveryMutation();
  const [resend, resending] = useResendRecoveryCodeMutation();
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [resent, setResent] = useState(false);

  const trimmed = code.trim();
  const shapeError =
    touched && !CODE_SHAPE.test(trimmed) ? recoveriesCopy.codeInvalidShape : undefined;
  const busy = verifying.isLoading || resending.isLoading;

  return (
    <section className="flex flex-col gap-3 rounded-md border-hairline border-border bg-surface p-4">
      <h2 className="text-h2 text-text">{recoveriesCopy.codeTitle}</h2>
      <p className="text-body text-text">{recoveriesCopy.codeBody}</p>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!CODE_SHAPE.test(trimmed)) return;
          setResent(false);
          void verify({ id: recoveryId, code: trimmed }).then((result) => {
            setFailure(failureOf(result));
            if ('data' in result) setCode('');
          });
        }}
      >
        <div className="max-w-xs">
          <TextField
            label={recoveriesCopy.codeLabel}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            error={shapeError}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        {failure !== undefined && <Banner tone="danger" message={recoveryErrorMessage(failure)} />}
        {resent && <Banner message={recoveriesCopy.resent} />}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            label={recoveriesCopy.confirmCode}
            loadingLabel={recoveriesCopy.confirmingCode}
            loading={verifying.isLoading}
            disabled={resending.isLoading}
          />
          <Button
            label={recoveriesCopy.resend}
            loadingLabel={recoveriesCopy.resending}
            loading={resending.isLoading}
            disabled={verifying.isLoading}
            variant="secondary"
            onClick={() => {
              setResent(false);
              void resend({ id: recoveryId }).then((result) => {
                const refused = failureOf(result);
                setFailure(refused);
                setResent(refused === undefined);
                if (refused === undefined) setCode('');
              });
            }}
          />
        </div>
      </form>
    </section>
  );
}
