import type { AdminCatalogueCategory } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import {
  type CategoryCreate,
  type CategoryPatch,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
} from './api';
import { CommonFieldsEditor } from './CommonFieldsEditor';
import { catalogueCopy } from './copy';
import {
  checkCommonFields,
  type CommonFields,
  commonFieldsFrom,
  type FieldErrors,
  hasErrors,
  nameFrom,
  parseDisplayOrder,
  sameName,
  serverFieldErrors,
} from './form-support';

export interface CategoryFormProps {
  /** The category being edited; absent to create one. */
  category?: AdminCatalogueCategory;
  onClose: () => void;
}

/** Create or edit a category, in a dialog. An edit sends only what changed. */
export function CategoryForm({ category, onClose }: CategoryFormProps) {
  const [fields, setFields] = useState(() => commonFieldsFrom(category));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, creating] = useCreateCategoryMutation();
  const [update, updating] = useUpdateCategoryMutation();
  const text = catalogueCopy.form;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkCommonFields(fields);
    setErrors(found);
    if (hasErrors(found)) return;

    const displayOrder = parseDisplayOrder(fields.displayOrder);
    let result: Awaited<ReturnType<typeof create>> | Awaited<ReturnType<typeof update>> | undefined;
    if (category === undefined) {
      result = await create(buildCreate(fields, displayOrder));
    } else {
      const patch = buildPatch(category, fields, displayOrder);
      // The API refuses an empty patch; saving an untouched form is just closing it.
      if (Object.keys(patch).length > 0) result = await update({ id: category.id, patch });
    }

    if (result?.error === undefined) onClose();
    else setErrors(serverFieldErrors(result.error));
  }

  return (
    <Dialog
      title={category === undefined ? text.createCategoryTitle : text.editCategoryTitle}
      onClose={onClose}
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {errors.form !== undefined && <Banner tone="danger" message={errors.form} />}
        <CommonFieldsEditor fields={fields} errors={errors} onChange={setFields} />
        <div className="flex justify-end gap-2">
          <Button label={text.cancel} variant="secondary" onClick={onClose} />
          <Button
            type="submit"
            label={text.save}
            loadingLabel={text.saving}
            loading={creating.isLoading || updating.isLoading}
          />
        </div>
      </form>
    </Dialog>
  );
}

function buildCreate(fields: CommonFields, displayOrder: number | undefined): CategoryCreate {
  return {
    slug: fields.slug.trim(),
    name: nameFrom(fields),
    isActive: fields.isActive,
    ...(displayOrder === undefined ? {} : { displayOrder }),
  };
}

function buildPatch(
  category: AdminCatalogueCategory,
  fields: CommonFields,
  displayOrder: number | undefined,
): CategoryPatch {
  const slug = fields.slug.trim();
  const name = nameFrom(fields, category.name);
  return {
    ...(slug === category.slug ? {} : { slug }),
    ...(sameName(name, category.name) ? {} : { name }),
    ...(displayOrder === undefined || displayOrder === category.displayOrder
      ? {}
      : { displayOrder }),
    ...(fields.isActive === category.isActive ? {} : { isActive: fields.isActive }),
  };
}
