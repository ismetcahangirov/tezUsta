import type { AdminMasterDetail, AdminMasterDocument } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatBytes, formatDateTime } from '../../format';
import { useAppDispatch } from '../../hooks';
import { openInNewTab } from '../../open-in-new-tab';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { availableActions } from './actions';
import { type MasterAction, mastersApi, useMasterDetailQuery } from './api';
import { mastersCopy } from './copy';
import { MasterActionDialog } from './MasterActionDialog';
import { MasterStatusBadge } from './MasterStatusBadge';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 font-bold text-text">{title}</h2>
      {children}
    </section>
  );
}

function BackLink() {
  return (
    <Link
      to="/masters"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {mastersCopy.back}
    </Link>
  );
}

/** One master's file (#248): profile, documents, verification trail, and the review actions. */
export function MasterDetailPage() {
  const { id = '' } = useParams();
  const { data: master, error, isLoading, refetch } = useMasterDetailQuery(id);
  const failure = describeFailure(error);

  if (master === undefined) {
    return (
      <PageFrame title={mastersCopy.title}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {mastersCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={mastersCopy.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={mastersCopy.detailLoadFailed} />
            <Button label={mastersCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )}
      </PageFrame>
    );
  }

  return <MasterFile master={master} />;
}

function MasterFile({ master }: { master: AdminMasterDetail }) {
  const me = useSignedInAdmin();
  const actions = availableActions(master.verificationStatus, me.permissions);
  const [pending, setPending] = useState<MasterAction | null>(null);
  const [done, setDone] = useState<MasterAction | null>(null);

  return (
    <PageFrame title={master.displayName}>
      <BackLink />
      <div className="flex flex-wrap items-center gap-3">
        <MasterStatusBadge status={master.verificationStatus} />
        {master.suspendedAt !== null && (
          <span className="text-caption text-text-muted">
            {mastersCopy.suspendedAt} {formatDateTime(master.suspendedAt)}
          </span>
        )}
      </div>

      {done !== null && <Banner message={mastersCopy.done[done]} />}

      {actions.length > 0 && (
        <div role="group" aria-label={mastersCopy.actions} className="flex flex-wrap gap-3">
          {actions.map((action) => (
            <Button
              key={action}
              label={mastersCopy.actionLabel[action]}
              variant={action === 'verify' || action === 'reinstate' ? 'accent' : 'secondary'}
              onClick={() => {
                setDone(null);
                setPending(action);
              }}
            />
          ))}
        </div>
      )}

      <Section title={mastersCopy.profile}>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
          <Fact label={mastersCopy.joined} value={formatDateTime(master.createdAt)} />
          <Fact
            label={mastersCopy.available}
            value={master.isAvailable ? mastersCopy.yes : mastersCopy.no}
          />
          <Fact label={mastersCopy.ratings} value={String(master.ratingCount)} />
          <div className="col-span-full flex flex-col gap-1">
            <dt className="text-caption text-text-muted">{mastersCopy.bio}</dt>
            <dd className="whitespace-pre-wrap text-body text-text">
              {master.bio ?? mastersCopy.noBio}
            </dd>
          </div>
        </dl>
      </Section>

      <Section title={mastersCopy.services}>
        <p className="text-body text-text-muted">{mastersCopy.servicesUnavailable}</p>
      </Section>

      <Section title={mastersCopy.documents}>
        <Documents masterId={master.id} documents={master.documents} />
      </Section>

      <Section title={mastersCopy.history}>
        {master.history.length === 0 ? (
          <p className="text-body text-text-muted">{mastersCopy.noHistory}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {master.history.map((event) => (
              <li
                key={`${event.createdAt}-${event.toStatus}`}
                className="flex flex-col gap-1 rounded-md border-hairline border-border bg-surface px-4 py-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-body-strong font-bold text-text">
                    {mastersCopy.historyEntry(
                      mastersCopy.status[event.fromStatus],
                      mastersCopy.status[event.toStatus],
                    )}
                  </span>
                  <span className="text-caption text-text-muted">
                    {mastersCopy.by(mastersCopy.actor[event.actorKind])} ·{' '}
                    {formatDateTime(event.createdAt)}
                  </span>
                </div>
                {event.reason !== null && (
                  <p className="whitespace-pre-wrap text-body text-text">{event.reason}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {pending !== null && (
        <MasterActionDialog
          masterId={master.id}
          masterName={master.displayName}
          action={pending}
          onClose={() => setPending(null)}
          onDone={(action) => {
            setPending(null);
            setDone(action);
          }}
        />
      )}
    </PageFrame>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body text-text">{value}</dd>
    </div>
  );
}

function Documents({
  masterId,
  documents,
}: {
  masterId: string;
  documents: readonly AdminMasterDocument[];
}) {
  const dispatch = useAppDispatch();
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  async function open(documentId: string) {
    setOpening(documentId);
    setOpenFailed(false);
    const opened = await openInNewTab(async () => {
      // `track: false`: the presigned URL is used once and never held in the store.
      const result = await dispatch(
        mastersApi.endpoints.masterDocumentDownload.initiate(
          { masterId, documentId },
          { track: false },
        ),
      );
      return result.data?.url;
    });
    setOpening(null);
    setOpenFailed(!opened);
  }

  if (documents.length === 0) {
    return <p className="text-body text-text-muted">{mastersCopy.noDocuments}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {openFailed && <Banner tone="danger" message={mastersCopy.openFailed} />}
      <Table caption={mastersCopy.documentsCaption}>
        <thead>
          <tr>
            {Object.values(mastersCopy.documentColumns).map((column) => (
              <th key={column} scope="col" className={TH_CLASS}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id}>
              <td className={TD_CLASS}>{mastersCopy.documentType[document.documentType]}</td>
              <td className={TD_CLASS}>{mastersCopy.documentStatus[document.status]}</td>
              <td className={TD_CLASS}>
                {document.sizeBytes === null ? mastersCopy.none : formatBytes(document.sizeBytes)}
              </td>
              <td className={TD_CLASS}>{document.verifiedContentType ?? mastersCopy.none}</td>
              <td className={TD_CLASS}>
                {document.submittedAt === null
                  ? mastersCopy.none
                  : formatDateTime(document.submittedAt)}
              </td>
              <td className={TD_CLASS}>
                {document.reviewedAt === null
                  ? mastersCopy.none
                  : formatDateTime(document.reviewedAt)}
              </td>
              <td className={TD_CLASS}>
                {document.status === 'awaiting_upload' ? (
                  <span className="text-caption text-text-muted">{mastersCopy.notUploaded}</span>
                ) : (
                  <Button
                    label={mastersCopy.open}
                    loadingLabel={mastersCopy.opening}
                    loading={opening === document.id}
                    variant="secondary"
                    aria-label={`${mastersCopy.open} ${mastersCopy.documentType[document.documentType]}`}
                    onClick={() => void open(document.id)}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
