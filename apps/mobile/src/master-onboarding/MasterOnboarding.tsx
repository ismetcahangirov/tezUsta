import type { MasterDocumentType } from '@tezusta/types';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { statusOf } from '../addresses/addresses-errors';
import {
  Banner,
  Button,
  ChevronLeftIcon,
  EmptyState,
  ListRow,
  Skeleton,
  StatusPill,
  Text,
  TextField,
} from '../components';
import type { StatusTone } from '../components/StatusPill';
import { useOwnMasterQuery } from '../master-jobs/master-jobs-endpoints';

import { withSupportAddress } from '../support';
import { MASTER_ONBOARDING_COPY as copy } from './master-onboarding-copy';
import { useOwnDocumentsQuery, useSubmitVerificationMutation } from './master-onboarding-endpoints';
import {
  canSubmit,
  documentSlots,
  onboardingStep,
  REQUIRED_DOCUMENTS,
  type DocumentSlot,
} from './onboarding-state';
import { useBecomeMaster } from './useBecomeMaster';
import { useDocumentUpload } from './useDocumentUpload';

/** Kept in step with `masters.schema.ts` on the API; the server re-validates. */
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_BIO_LENGTH = 600;

const SLOT_TONE: Record<DocumentSlot, StatusTone> = {
  missing: 'unfilled',
  in_review: 'pending',
  accepted: 'done',
  rejected: 'cancelled',
};

export interface MasterOnboardingProps {
  /** Leaves the screen the way it was entered. */
  readonly onBack: () => void;
  /** Opens the master's own area, once there is a master profile. */
  readonly onOpenMaster: () => void;
}

/**
 * Becoming a master, from either entry point (#490, ADR-0073): the profile,
 * the three ADR-0023 documents, and the wait for review.
 *
 * **Every step is read from the server**, never kept in local state, so the
 * screen opens where the person left off — on another day, after a crash, or
 * on a second phone — and a `changes_requested` master who comes back lands
 * on the documents with the rejected ones marked.
 *
 * `GET /masters/me` answers 403 to an account without the `master` role and
 * 404 to one whose profile is gone; both mean "no profile yet".
 */
export function MasterOnboarding({
  onBack,
  onOpenMaster,
}: MasterOnboardingProps): React.JSX.Element {
  const master = useOwnMasterQuery();
  const masterStatus = statusOf(master.error);
  const noProfile = masterStatus === 403 || masterStatus === 404;
  const profile = master.currentData;
  const hasProfile = profile !== undefined;
  const documents = useOwnDocumentsQuery(undefined, { skip: !hasProfile });

  const header = (
    <Button
      label={copy.back}
      icon={<ChevronLeftIcon />}
      variant="ghost"
      size="sm"
      className="-ml-4 self-start"
      onPress={onBack}
    />
  );

  if (!hasProfile && !noProfile) {
    if (master.isLoading || master.isFetching) {
      return (
        <View className="flex-1 gap-6 p-6">
          {header}
          <Skeleton
            className="h-control-lg w-full rounded-full"
            accessibilityLabel={copy.loading}
          />
        </View>
      );
    }
    return (
      <View className="flex-1 gap-6 p-6">
        {header}
        <EmptyState
          title={copy.loadError}
          action={
            <Button
              label={copy.retry}
              variant="secondary"
              onPress={() => {
                void master.refetch();
              }}
            />
          }
        />
      </View>
    );
  }

  if (profile === undefined) {
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-6 p-6">
          {header}
          <ProfileStep />
        </View>
      </ScrollView>
    );
  }

  const slots = documentSlots(documents.currentData ?? []);
  const step = onboardingStep(profile.verificationStatus, slots);

  return (
    <ScrollView>
      <View className="gap-6 p-6">
        {header}
        {step === 'active' && (
          <Outcome
            title={copy.activeTitle}
            description={copy.activeDescription}
            onOpenMaster={onOpenMaster}
          />
        )}
        {step === 'closed' && (
          <Outcome
            title={copy.closedTitle}
            description={withSupportAddress(copy.closedDescription)}
          />
        )}
        {(step === 'documents' || step === 'in_review') && (
          <DocumentsStep
            step={step}
            changesRequested={profile.verificationStatus === 'changes_requested'}
            slots={slots}
            loading={documents.isLoading}
            onOpenMaster={onOpenMaster}
          />
        )}
      </View>
    </ScrollView>
  );
}

function ProfileStep(): React.JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const { creating, failed, create } = useBecomeMaster();
  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();

  function submit(): void {
    if (trimmedName.length === 0 || creating) return;
    void create(
      trimmedBio.length === 0
        ? { displayName: trimmedName }
        : { displayName: trimmedName, bio: trimmedBio },
    );
  }

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text variant="h1">{copy.profileTitle}</Text>
        <Text variant="lead" tone="muted">
          {copy.profileDescription}
        </Text>
      </View>

      {failed && <Banner tone="danger" message={copy.profileError} />}

      <TextField
        label={copy.nameField}
        placeholder={copy.namePlaceholder}
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={MAX_DISPLAY_NAME_LENGTH}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="givenName"
      />
      <TextField
        label={copy.bioField}
        placeholder={copy.bioPlaceholder}
        value={bio}
        onChangeText={setBio}
        maxLength={MAX_BIO_LENGTH}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
      />

      <Button
        label={copy.profileAction}
        variant="accent"
        size="lg"
        onPress={submit}
        loading={creating}
        disabled={trimmedName.length === 0}
      />
    </View>
  );
}

interface DocumentsStepProps {
  readonly step: 'documents' | 'in_review';
  readonly changesRequested: boolean;
  readonly slots: Record<MasterDocumentType, DocumentSlot>;
  readonly loading: boolean;
  readonly onOpenMaster: () => void;
}

function DocumentsStep({
  step,
  changesRequested,
  slots,
  loading,
  onOpenMaster,
}: DocumentsStepProps): React.JSX.Element {
  const [submit, submitResult] = useSubmitVerificationMutation();
  const inReview = step === 'in_review';

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text variant="h1">{inReview ? copy.inReviewTitle : copy.documentsTitle}</Text>
        <Text variant="lead" tone="muted">
          {inReview ? copy.inReviewDescription : copy.documentsDescription}
        </Text>
      </View>

      {changesRequested && <Banner tone="danger" message={copy.documentsChangesRequested} />}

      {loading ? (
        <Skeleton className="h-control-lg w-full rounded-full" accessibilityLabel={copy.loading} />
      ) : (
        <View className="gap-3">
          {REQUIRED_DOCUMENTS.map((type) => (
            <DocumentRow key={type} documentType={type} slot={slots[type]} />
          ))}
          <Text variant="caption" tone="muted">
            {copy.cameraHint}
          </Text>
        </View>
      )}

      {submitResult.isError && <Banner tone="danger" message={copy.submitError} />}

      {changesRequested && (
        <Button
          label={copy.submitAction}
          variant="accent"
          size="lg"
          loading={submitResult.isLoading}
          disabled={!canSubmit(slots)}
          onPress={() => {
            void submit();
          }}
        />
      )}

      {inReview && (
        <Button label={copy.goToMaster} variant="secondary" size="lg" onPress={onOpenMaster} />
      )}
    </View>
  );
}

function DocumentRow({
  documentType,
  slot,
}: {
  documentType: MasterDocumentType;
  slot: DocumentSlot;
}): React.JSX.Element {
  const upload = useDocumentUpload(documentType);
  const uploading = upload.phase === 'uploading';
  const label = slot === 'missing' ? copy.pickPhoto : copy.replacePhoto;

  return (
    <View className="gap-2">
      <ListRow
        title={copy.documentLabels[documentType]}
        titleNumberOfLines={2}
        {...(uploading
          ? {
              subtitle: copy.uploading,
              progress: { value: Math.round(upload.progress * 100), max: 100 },
            }
          : {})}
        trailing={<StatusPill status={SLOT_TONE[slot]} label={copy.slotLabels[slot]} />}
      />
      {upload.phase === 'failed' && (
        <Banner
          tone="danger"
          message={copy.uploadFailed}
          action={
            <Button
              label={copy.retryUpload}
              variant="secondary"
              size="sm"
              onPress={() => {
                void upload.retry();
              }}
            />
          }
        />
      )}
      {upload.permissionDenied && <Banner tone="danger" message={copy.libraryDenied} />}
      {slot !== 'accepted' && (
        <Button
          label={label}
          variant="secondary"
          size="sm"
          className="self-start"
          loading={uploading}
          onPress={() => {
            void upload.pick();
          }}
        />
      )}
    </View>
  );
}

function Outcome({
  title,
  description,
  onOpenMaster,
}: {
  title: string;
  description: string;
  onOpenMaster?: () => void;
}): React.JSX.Element {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text variant="h1">{title}</Text>
        <Text variant="lead" tone="muted">
          {description}
        </Text>
      </View>
      {onOpenMaster !== undefined && (
        <Button label={copy.goToMaster} variant="accent" size="lg" onPress={onOpenMaster} />
      )}
    </View>
  );
}
