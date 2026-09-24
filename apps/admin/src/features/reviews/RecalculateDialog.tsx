import type { RatingRecalculation, RecalculateRatingsRequest } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { isUuid } from '../../uuid';
import { useRecalculateRatingsMutation } from './api';
import { reviewsCopy } from './copy';

type Scope = 'everyone' | 'master' | 'customer';

/**
 * The confirm step before `POST /admin/ratings/recalculate` (#223) — for
 * everyone, one master or one customer. It repairs stored aggregates and
 * never touches a review, but "everyone" is a full recount, so it asks first.
 */
export function RecalculateDialog({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<Scope>('everyone');
  const [id, setId] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<RatingRecalculation | null>(null);
  const [recalculate, { isLoading, isError }] = useRecalculateRatingsMutation();
  const text = reviewsCopy.recalculation;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (scope !== 'everyone' && !isUuid(id)) {
      setIdError(text.invalidId);
      return;
    }
    setIdError(undefined);
    const body: RecalculateRatingsRequest =
      scope === 'everyone'
        ? {}
        : scope === 'master'
          ? { masterId: id.trim() }
          : { customerId: id.trim() };
    const result = await recalculate(body);
    if (result.data !== undefined) setOutcome(result.data);
  }

  return (
    <Dialog title={text.title} onClose={onClose}>
      {outcome === null ? (
        <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          {isError && <Banner tone="danger" message={text.failed} />}
          <p className="text-body text-text-muted">{text.explain}</p>
          <SelectField
            label={text.scope}
            value={scope}
            options={[
              { value: 'everyone', label: text.everyone },
              { value: 'master', label: text.master },
              { value: 'customer', label: text.customer },
            ]}
            onChange={(event) => {
              setScope(event.target.value as Scope);
            }}
          />
          {scope !== 'everyone' && (
            <TextField
              label={text.id}
              value={id}
              error={idError}
              spellCheck={false}
              onChange={(event) => {
                setId(event.target.value);
              }}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button label={text.cancel} variant="secondary" onClick={onClose} />
            <Button
              type="submit"
              label={text.confirm}
              loadingLabel={text.confirming}
              loading={isLoading}
            />
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <Banner message={text.done(outcome.mastersCorrected, outcome.customersCorrected)} />
          <div className="flex justify-end">
            <Button label={text.close} onClick={onClose} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
