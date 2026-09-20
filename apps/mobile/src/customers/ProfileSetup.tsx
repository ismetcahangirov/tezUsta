import { useState } from 'react';
import { View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, Text, TextField } from '../components';
import { CUSTOMERS_COPY as copy } from './customers-copy';
import { MAX_DISPLAY_NAME_LENGTH, useCreateCustomerProfileMutation } from './customers-endpoints';

/**
 * The per-field issues a 422 carried, keyed by the path the server named —
 * `displayName` here, which is the only field this request has.
 *
 * A local copy of `addresses-errors.ts`'s `fieldErrorsOf`, narrowed to the one
 * field, for the reason that file gives about the envelope: `apps/mobile` may
 * not import `apps/api`, and nothing here casts a shape that came off the
 * network without checking it first.
 */
function displayNameIssue(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return undefined;
  }
  const body = (error as { data?: unknown }).data;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const envelope = (body as { error?: unknown }).error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) {
    return undefined;
  }
  const issues = (envelope as { details?: { issues?: unknown } }).details?.issues;
  if (!Array.isArray(issues)) {
    return undefined;
  }

  for (const issue of issues) {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      (issue as { path?: unknown }).path === 'displayName' &&
      typeof (issue as { message?: unknown }).message === 'string'
    ) {
      return (issue as { message: string }).message;
    }
  }
  return undefined;
}

function statusOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  return (error as { status?: unknown }).status;
}

/**
 * The one question a first-run customer is asked (issue #94).
 *
 * ## Why it is asked at all
 *
 * Sign-in is phone + SMS OTP ([ADR-0008](docs/decisions/ADR-0008-otp-delivery.md))
 * and carries no name, while `POST /customers` requires a `displayName` — so
 * before this screen existed, a signed-in phone had no `customers` row and
 * every customer-scoped endpoint answered 404: saved addresses, order
 * creation, order reads, all of it. The alternatives were making the name
 * optional, or having the server invent a placeholder at first sign-in.
 * [ADR-0028](docs/decisions/ADR-0028-customer-profile-at-first-run.md) records
 * why asking won: the name is not paperwork, it is what the master who turns
 * up at somebody's door is shown, and neither alternative produces one.
 *
 * ## Why it is one field and nothing else
 *
 * A first-run *flow* — what a new user is shown, in what order, with what
 * artwork — is the owner's decision and is still open (CLAUDE.md §17). This is
 * deliberately not that. It is the single question the API cannot proceed
 * without, asked once, in the components the design system already supplies
 * (ADR-0011). Anything more would be inventing the onboarding this repository
 * is not entitled to invent; anything less leaves the customer half of the
 * product unusable on a device.
 *
 * ## What it does not do
 *
 * It does not navigate. The gate that renders it re-reads the profile and
 * renders the customer area when one exists, so there is no route to push and
 * no back stack in which a customer could return to a question they have
 * already answered.
 */
export function ProfileSetup(): React.JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [createProfile, result] = useCreateCustomerProfileMutation();

  const trimmed = displayName.trim();
  const fieldError = displayNameIssue(result.error);
  const bannerMessage =
    result.error === undefined || fieldError !== undefined
      ? undefined
      : isTransportFailure(statusOf(result.error))
        ? copy.offlineError
        : copy.saveError;

  function submit(): void {
    // The server trims and re-validates; this only stops an obviously empty
    // submission from becoming a round trip and a 422 (CLAUDE.md §11 — the
    // client's check is a convenience, never the enforcement).
    if (trimmed.length === 0 || result.isLoading) {
      return;
    }
    void createProfile({ displayName: trimmed });
  }

  return (
    <View className="flex-1 justify-center gap-6 p-6">
      <View className="gap-2">
        <Text variant="h1">{copy.setupTitle}</Text>
        <Text variant="body" tone="muted">
          {copy.setupDescription}
        </Text>
      </View>

      {bannerMessage !== undefined && <Banner tone="danger" message={bannerMessage} />}

      <TextField
        label={copy.nameField}
        placeholder={copy.namePlaceholder}
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={MAX_DISPLAY_NAME_LENGTH}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="givenName"
        returnKeyType="done"
        onSubmitEditing={submit}
        {...(fieldError === undefined ? {} : { error: fieldError })}
      />

      <Button
        label={copy.setupAction}
        variant="accent"
        size="lg"
        onPress={submit}
        loading={result.isLoading}
        disabled={trimmed.length === 0}
      />
    </View>
  );
}
