import type {
  AccountRecoveryPhotoKind,
  AdminAccountRecovery,
  AdminAccountRecoveryPhoto,
  AdminMasterDocument,
} from '@tezusta/types';
import { useState } from 'react';

import { type ApiFailure, describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatBytes, formatDateTime } from '../../format';
import { useAppDispatch } from '../../hooks';
import { openInNewTab } from '../../open-in-new-tab';
import { useSignedInAdmin } from '../../shell/Shell';
import { mastersApi, useMasterDetailQuery } from '../masters/api';
import {
  recoveriesApi,
  useConfirmRecoveryPhotoMutation,
  usePresignRecoveryPhotoMutation,
  useRecoveryPhotosQuery,
} from './api';
import { recoveriesCopy, recoveryErrorMessage } from './copy';
import { adminName, isOpen } from './rules';

const copy = recoveriesCopy.photos;

const KINDS: readonly AccountRecoveryPhotoKind[] = ['selfie_with_id', 'id_card_front'];

/** What the confirm can check (#524); anything else is refused before it is sent. */
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AcceptedType = (typeof ACCEPTED_TYPES)[number];

function isAccepted(type: string): type is AcceptedType {
  return (ACCEPTED_TYPES as readonly string[]).includes(type);
}

/**
 * The master's new photos beside the documents on file (#524, ADR-0074 § 2,
 * ADR-0075): the side-by-side view the evidence is matched on.
 *
 * Adding a photo is ADR-0024's upload: presign, a PUT from this browser
 * straight to the private bucket, then a confirm the server checks. Opening
 * one, new or on file, mints a short-lived link in a new tab, and each is an
 * audited read; no link is kept in the store.
 */
export function RecoveryPhotos({ recovery }: { recovery: AdminAccountRecovery }) {
  const me = useSignedInAdmin();
  const masterId = recovery.masterId;
  const photos = useRecoveryPhotosQuery(recovery.id);
  const master = useMasterDetailQuery(masterId ?? '', {
    skip: masterId === null || !me.permissions.includes('masters.read'),
  });
  const dispatch = useAppDispatch();
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  if (masterId === null) return null;

  async function open(key: string, mint: () => Promise<string | undefined>) {
    setOpening(key);
    setOpenFailed(false);
    const opened = await openInNewTab(mint);
    setOpening(null);
    setOpenFailed(!opened);
  }

  function openPhoto(photo: AdminAccountRecoveryPhoto) {
    void open(photo.id, async () => {
      const result = await dispatch(
        recoveriesApi.endpoints.recoveryPhotoDownload.initiate(
          { id: recovery.id, photoId: photo.id },
          { track: false },
        ),
      );
      return result.data?.url;
    });
  }

  function openDocument(document: AdminMasterDocument) {
    if (masterId === null) return;
    void open(document.id, async () => {
      const result = await dispatch(
        mastersApi.endpoints.masterDocumentDownload.initiate(
          { masterId, documentId: document.id },
          { track: false },
        ),
      );
      return result.data?.url;
    });
  }

  const stored = new Map((photos.data ?? []).map((photo) => [photo.kind, photo]));
  const onFile = (kind: AccountRecoveryPhotoKind): AdminMasterDocument | undefined =>
    master.data?.documents.find(
      (document) => document.documentType === kind && document.status !== 'awaiting_upload',
    );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 text-text">{copy.title}</h2>
      <p className="text-body text-text-muted">{copy.intro}</p>
      {photos.isError && <Banner tone="danger" message={copy.loadFailed} />}
      {master.isError && <Banner tone="danger" message={copy.filesUnavailable} />}
      {openFailed && <Banner tone="danger" message={copy.openFailed} />}
      <Table caption={copy.caption}>
        <thead>
          <tr>
            {Object.values(copy.columns).map((column) => (
              <th key={column} scope="col" className={TH_CLASS}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KINDS.map((kind) => {
            const photo = stored.get(kind);
            const document = onFile(kind);
            return (
              <tr key={kind}>
                <td className={TD_CLASS}>{copy.kind[kind]}</td>
                <td className={TD_CLASS}>
                  {photo !== undefined ? (
                    <div className="flex flex-col items-start gap-1">
                      <Button
                        label={copy.open}
                        loadingLabel={copy.opening}
                        loading={opening === photo.id}
                        variant="secondary"
                        aria-label={copy.openLabel(copy.kind[kind])}
                        onClick={() => openPhoto(photo)}
                      />
                      <span className="text-caption text-text-muted">
                        {copy.added(
                          adminName(me, photo.uploadedByAdminId, photo.uploadedByName),
                          formatDateTime(photo.storedAt),
                        )}
                      </span>
                    </div>
                  ) : isOpen(recovery) && photos.isSuccess ? (
                    <PhotoUpload recoveryId={recovery.id} kind={kind} />
                  ) : (
                    <span className="text-caption text-text-muted">{copy.notAdded}</span>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {document === undefined ? (
                    <span className="text-caption text-text-muted">{copy.noneOnFile}</span>
                  ) : (
                    <Button
                      label={copy.open}
                      loadingLabel={copy.opening}
                      loading={opening === document.id}
                      variant="secondary"
                      aria-label={copy.openFileLabel(copy.kind[kind])}
                      onClick={() => openDocument(document)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}

/** One photo's upload: checked here first, then by the server at confirm. */
function PhotoUpload({ recoveryId, kind }: { recoveryId: string; kind: AccountRecoveryPhotoKind }) {
  const [presign] = usePresignRecoveryPhotoMutation();
  const [confirm] = useConfirmRecoveryPhotoMutation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function upload(file: File): Promise<string | null> {
    if (!isAccepted(file.type)) return copy.notImage;

    const presigned = await presign({ id: recoveryId, kind, contentType: file.type });
    if ('error' in presigned) return recoveryErrorMessage(describeFailure(presigned.error));
    const { photoId, uploadUrl, contentType, maxBytes } = presigned.data;
    // The unused presign is cleared by the server's sweep.
    if (file.size > maxBytes) return copy.tooLarge(formatBytes(maxBytes));

    try {
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': contentType },
        // The bucket is another origin: no cookie or referrer goes with the bytes.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!put.ok) return copy.storageUnreachable;
    } catch {
      return copy.storageUnreachable;
    }

    const confirmed = await confirm({ id: recoveryId, photoId });
    if ('error' in confirmed) return confirmProblem(describeFailure(confirmed.error));
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <label className="flex flex-col gap-1 text-caption text-text-muted">
        {busy ? copy.uploading : copy.uploadLabel(copy.kind[kind])}
        <input
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          disabled={busy}
          className="text-caption text-text"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (file === undefined) return;
            setBusy(true);
            setProblem(null);
            void upload(file).then((result) => {
              setBusy(false);
              setProblem(result);
              input.value = '';
            });
          }}
        />
      </label>
      {problem !== null && <Banner tone="danger" message={problem} />}
    </div>
  );
}

function confirmProblem(failure: ApiFailure | undefined): string {
  if (failure?.code === 'VALIDATION_FAILED') return copy.refused;
  if (failure?.code === 'CONFLICT') return copy.notArrived;
  return recoveryErrorMessage(failure);
}
