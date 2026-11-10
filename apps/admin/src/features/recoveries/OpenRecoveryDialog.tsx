import type { AccountRecoverySubject, AdminOrderSummary } from '@tezusta/types';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Modal } from '../../components/Modal';
import { TextField } from '../../components/TextField';
import { formatDateTime } from '../../format';
import { useOpenRecoveryMutation } from './api';
import { recoveriesCopy, recoveryErrorMessage } from './copy';

const copy = recoveriesCopy.open;

/** The table's CHECK caps the notes at 4000 (#515). */
const NOTES_MAX_LENGTH = 4000;

/** ADR-0074 § 2: a customer proves the account with at least three facts. */
export const FACTS_REQUIRED = 3;

/** A whole address, roughly: the server normalises and checks it properly. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CustomerFact = keyof typeof copy.customerFacts;
const FACTS = Object.keys(copy.customerFacts) as CustomerFact[];

/** What the account itself holds for each fact, read from the customer's file. */
export type AccountAnswers = Readonly<Record<CustomerFact, readonly string[]>>;

export function accountAnswers(
  displayName: string,
  addressLabels: readonly (string | null)[],
  orders: readonly AdminOrderSummary[],
): AccountAnswers {
  return {
    name: [displayName],
    address: addressLabels.filter((label): label is string => label !== null),
    order: orders.map((order) => `${order.serviceName}, ${formatDateTime(order.createdAt)}`),
    master: [
      ...new Set(
        orders.map((order) => order.masterName).filter((name): name is string => name !== null),
      ),
    ],
  };
}

export type OpenRecoveryDialogProps = {
  subject: AccountRecoverySubject;
  title: string;
  onClose: () => void;
} & (
  | { readonly evidence: 'master' }
  | { readonly evidence: 'customer'; readonly answers: AccountAnswers }
);

/**
 * Opens a recovery (#517, ADR-0074 § 2) from a customer's or a master's file.
 *
 * The evidence step comes first and cannot be skipped: a master's request
 * needs the document match confirmed; a customer's needs at least three facts
 * confirmed, and the account's own answers are shown only once the admin has
 * written down what the user said, so the account never prompts the answer.
 * The API cannot see any of this, so it is the panel's to hold.
 */
export function OpenRecoveryDialog(props: OpenRecoveryDialogProps) {
  const { subject, title, onClose } = props;
  const navigate = useNavigate();
  const [openRecovery, { isLoading }] = useOpenRecoveryMutation();

  const [newEmail, setNewEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [masterMatch, setMasterMatch] = useState(false);
  const [said, setSaid] = useState<Record<CustomerFact, string>>({
    name: '',
    address: '',
    order: '',
    master: '',
  });
  const [compared, setCompared] = useState(false);
  const [matched, setMatched] = useState<ReadonlySet<CustomerFact>>(new Set());
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const notesId = useId();

  const emailError =
    touched && !EMAIL_SHAPE.test(newEmail.trim()) ? copy.newEmailInvalid : undefined;
  const notesProblem =
    notes.trim().length === 0
      ? copy.notesEmpty
      : notes.trim().length > NOTES_MAX_LENGTH
        ? copy.notesTooLong
        : undefined;
  const evidenceProblem =
    props.evidence === 'master'
      ? masterMatch
        ? undefined
        : copy.masterMatchRequired
      : matched.size >= FACTS_REQUIRED
        ? undefined
        : copy.factsRequired(matched.size);

  async function submit() {
    setTouched(true);
    if (emailError !== undefined || !EMAIL_SHAPE.test(newEmail.trim())) return;
    if (notesProblem !== undefined || evidenceProblem !== undefined) return;
    setFailure(null);
    const summary =
      props.evidence === 'customer'
        ? `\n\n${copy.summary(FACTS.filter((fact) => matched.has(fact)).map((fact) => copy.customerFacts[fact]))}`
        : `\n\n${copy.masterMatch}`;
    const result = await openRecovery({
      subject,
      newEmail: newEmail.trim(),
      evidenceNotes: `${notes.trim()}${summary}`,
    });
    if ('error' in result) {
      setFailure(describeFailure(result.error));
      return;
    }
    void navigate(`/recoveries/${result.data.id}`);
  }

  return (
    <Modal title={title} onClose={onClose} busy={isLoading}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {props.evidence === 'master' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-h3 text-text">{copy.masterEvidence}</legend>
            <p className="text-body text-text">{copy.masterEvidenceBody}</p>
            <p className="text-caption text-text-muted">{copy.masterPhotosNote}</p>
            <Checkbox
              label={copy.masterMatch}
              checked={masterMatch}
              disabled={isLoading}
              onChange={(event) => setMasterMatch(event.target.checked)}
            />
          </fieldset>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-h3 text-text">{copy.customerEvidence}</legend>
            <p className="text-body text-text">{copy.customerEvidenceBody}</p>
            {FACTS.map((fact) => (
              <div key={fact} className="flex flex-col gap-2">
                <TextField
                  label={copy.saidLabel(copy.customerFacts[fact])}
                  value={said[fact]}
                  readOnly={compared}
                  disabled={isLoading}
                  onChange={(event) => setSaid({ ...said, [fact]: event.target.value })}
                />
                {compared && (
                  <div className="flex flex-col gap-1 pl-5">
                    <span className="text-caption text-text-muted">{copy.accountHas}</span>
                    {props.answers[fact].length === 0 ? (
                      <span className="text-body text-text-muted">{copy.accountHasNothing}</span>
                    ) : (
                      <ul className="text-body text-text">
                        {props.answers[fact].map((answer) => (
                          <li key={answer}>{answer}</li>
                        ))}
                      </ul>
                    )}
                    <Checkbox
                      label={copy.matches(copy.customerFacts[fact])}
                      checked={matched.has(fact)}
                      // Nothing said is nothing to match.
                      disabled={isLoading || said[fact].trim() === ''}
                      onChange={(event) => {
                        const next = new Set(matched);
                        if (event.target.checked) next.add(fact);
                        else next.delete(fact);
                        setMatched(next);
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
            {!compared && (
              <div>
                <Button
                  label={copy.compare}
                  variant="secondary"
                  disabled={FACTS.every((fact) => said[fact].trim() === '')}
                  onClick={() => setCompared(true)}
                />
              </div>
            )}
          </fieldset>
        )}

        <TextField
          label={copy.newEmailLabel}
          hint={copy.newEmailHint}
          type="email"
          autoComplete="off"
          value={newEmail}
          error={emailError}
          disabled={isLoading}
          onChange={(event) => setNewEmail(event.target.value)}
        />

        <div className="flex flex-col gap-2">
          <label htmlFor={notesId} className="text-caption text-text-muted">
            {copy.notesLabel}
          </label>
          <textarea
            id={notesId}
            rows={4}
            value={notes}
            disabled={isLoading}
            aria-invalid={touched && notesProblem !== undefined}
            aria-describedby={`${notesId}-note`}
            className="w-full rounded-md border-hairline border-border bg-surface px-4 py-3 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onChange={(event) => setNotes(event.target.value)}
          />
          <p
            id={`${notesId}-note`}
            className={`text-footnote ${touched && notesProblem !== undefined ? 'text-danger' : 'text-text-muted'}`}
          >
            {touched && notesProblem !== undefined ? notesProblem : copy.notesHint}
          </p>
        </div>

        {touched && evidenceProblem !== undefined && (
          <Banner tone="danger" message={evidenceProblem} />
        )}
        {failure !== null && <Banner tone="danger" message={recoveryErrorMessage(failure)} />}

        <div className="flex justify-end gap-3">
          <Button label={copy.cancel} variant="secondary" disabled={isLoading} onClick={onClose} />
          <Button
            type="submit"
            label={copy.submit}
            loadingLabel={copy.submitting}
            loading={isLoading}
          />
        </div>
      </form>
    </Modal>
  );
}
