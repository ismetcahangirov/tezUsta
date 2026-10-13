import type { AdminReportDetail, AdminReportParty } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { OrderStatusBadge } from '../orders/OrderStatusBadge';
import { useClaimReportMutation, useReportDetailQuery } from './api';
import { CloseReportDialog } from './CloseReportDialog';
import { reportErrorMessage, reportsCopy } from './copy';

const LINK_CLASS =
  'font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 font-bold text-text">{title}</h2>
      {children}
    </section>
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

function BackLink() {
  return (
    <Link
      to="/reports"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {reportsCopy.back}
    </Link>
  );
}

/** One report (#330): what was said, the order, both parties, and the claim and close actions. */
export function ReportDetailPage() {
  const { id = '' } = useParams();
  const { data: report, error, isLoading, refetch } = useReportDetailQuery(id);
  const failure = describeFailure(error);

  if (report === undefined) {
    return (
      <PageFrame title={reportsCopy.title}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {reportsCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={reportsCopy.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={reportsCopy.detailLoadFailed} />
            <Button label={reportsCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )}
      </PageFrame>
    );
  }
  return <ReportFile report={report} />;
}

function ReportFile({ report }: { report: AdminReportDetail }) {
  const me = useSignedInAdmin();
  const canHandle = me.permissions.includes('reports.handle');
  const [claim, claimState] = useClaimReportMutation();
  const claimFailure = describeFailure(claimState.error);
  const [closing, setClosing] = useState(false);

  return (
    <PageFrame title={`${reportsCopy.reason[report.reasonCode]} — ${report.reported.displayName}`}>
      <BackLink />
      <p className="text-caption text-text-muted">
        {reportsCopy.status[report.status]} · {formatDateTime(report.createdAt)}
      </p>

      {canHandle && report.status !== 'closed' && (
        <div className="flex flex-wrap gap-3">
          {report.status === 'open' ? (
            <Button
              label={reportsCopy.claim}
              loadingLabel={reportsCopy.claiming}
              loading={claimState.isLoading}
              onClick={() => void claim(report.id)}
            />
          ) : (
            <Button label={reportsCopy.close} onClick={() => setClosing(true)} />
          )}
        </div>
      )}
      {claimFailure !== undefined && (
        <Banner tone="danger" message={reportErrorMessage(claimFailure.code)} />
      )}

      <Section title={reportsCopy.whatTheySaid}>
        {/* Text only: user content is never rendered as markup. */}
        <p className="whitespace-pre-wrap rounded-md border-hairline border-border bg-surface p-4 text-body text-text">
          {report.text ?? reportsCopy.noText}
        </p>
        <p className="text-footnote text-text-muted">{reportsCopy.textNote}</p>
      </Section>

      <Section title={reportsCopy.parties}>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4">
          <Fact label={reportsCopy.columns.reporter}>
            <PartyLink party={report.reporter} />
          </Fact>
          <Fact label={reportsCopy.columns.reported}>
            <PartyLink party={report.reported} />
            <span className="block text-caption text-text-muted">
              {reportsCopy.repeat(report.reportsAboutReportedLast30Days)}
            </span>
          </Fact>
        </dl>
      </Section>

      <Section title={reportsCopy.order}>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
          <Fact label={reportsCopy.service}>{report.order.serviceName}</Fact>
          <Fact label={reportsCopy.columns.status}>
            <OrderStatusBadge status={report.order.status} />
          </Fact>
          <Fact label={reportsCopy.ordered}>{formatDateTime(report.order.createdAt)}</Fact>
          <Fact label={reportsCopy.order}>
            {me.permissions.includes('orders.read') ? (
              <Link to={`/orders/${report.order.id}`} className={LINK_CLASS}>
                {reportsCopy.openOrder}
              </Link>
            ) : (
              reportsCopy.none
            )}
          </Fact>
        </dl>
      </Section>

      {report.handledBy !== null && (
        <Section title={reportsCopy.handledBy}>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
            <Fact label={reportsCopy.handledBy}>{report.handledBy.displayName}</Fact>
            <Fact label={reportsCopy.claimedAt}>
              {report.claimedAt === null ? reportsCopy.none : formatDateTime(report.claimedAt)}
            </Fact>
            {report.outcome !== null && (
              <>
                <Fact label={reportsCopy.outcome}>{reportsCopy.outcomes[report.outcome]}</Fact>
                <Fact label={reportsCopy.closedAt}>
                  {report.closedAt === null ? reportsCopy.none : formatDateTime(report.closedAt)}
                </Fact>
                <div className="col-span-full flex flex-col gap-1">
                  <dt className="text-caption text-text-muted">{reportsCopy.outcomeReason}</dt>
                  <dd className="whitespace-pre-wrap text-body text-text">
                    {report.outcomeReason}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </Section>
      )}

      {closing && (
        <CloseReportDialog
          reportId={report.id}
          onClose={() => setClosing(false)}
          onDone={() => setClosing(false)}
        />
      )}
    </PageFrame>
  );
}

/** A link to the party's own page when this admin may open it; the name alone otherwise. */
function PartyLink({ party }: { party: AdminReportParty }) {
  const me = useSignedInAdmin();
  const path = party.role === 'master' ? 'masters' : 'customers';
  const permission = party.role === 'master' ? 'masters.read' : 'customers.read';
  return (
    <>
      {me.permissions.includes(permission) ? (
        <Link to={`/${path}/${party.profileId}`} className={LINK_CLASS}>
          {party.displayName}
        </Link>
      ) : (
        party.displayName
      )}
      <span className="block text-caption text-text-muted">{reportsCopy.role[party.role]}</span>
    </>
  );
}
