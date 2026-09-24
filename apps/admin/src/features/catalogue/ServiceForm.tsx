import type {
  AdminCatalogueCategory,
  AdminCatalogueService,
  ServicePricingKind,
} from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import {
  type ServiceCreate,
  type ServicePatch,
  useCreateServiceMutation,
  useUpdateServiceMutation,
} from './api';
import { CommonFieldsEditor } from './CommonFieldsEditor';
import { catalogueCopy } from './copy';
import {
  azName,
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
import { minorToAznInput, parseAznToMinor } from './money';

export interface ServiceFormProps {
  categories: readonly AdminCatalogueCategory[];
  /** The service being edited; absent to create one in `categoryId`. */
  service?: AdminCatalogueService;
  categoryId: string;
  onClose: () => void;
}

interface ServiceFields extends CommonFields {
  categoryId: string;
  pricingKind: ServicePricingKind;
  price: string;
}

/**
 * Create or edit a service, in a dialog. The pricing rule is the API's: a
 * `fixed` service needs a reference price and an `inspection` one has none —
 * so the price field is switched off, and nothing is sent for it, while
 * inspection is chosen.
 */
export function ServiceForm({ categories, service, categoryId, onClose }: ServiceFormProps) {
  const [fields, setFields] = useState<ServiceFields>(() => ({
    ...commonFieldsFrom(service),
    categoryId: service?.categoryId ?? categoryId,
    pricingKind: service?.pricingKind ?? 'fixed',
    price:
      service?.basePriceMinor === null || service === undefined
        ? ''
        : minorToAznInput(service.basePriceMinor),
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, creating] = useCreateServiceMutation();
  const [update, updating] = useUpdateServiceMutation();
  const text = catalogueCopy.form;
  const inspection = fields.pricingKind === 'inspection';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = checkCommonFields(fields);
    let priceMinor: number | null = null;
    if (!inspection) {
      const parsed = parseAznToMinor(fields.price);
      if (parsed.ok) priceMinor = parsed.minor;
      else if (fields.price.trim() === '') found.price = text.priceRequired;
      else found.price = parsed.reason === 'format' ? text.priceFormat : text.priceRange;
    }
    setErrors(found);
    if (hasErrors(found)) return;

    const displayOrder = parseDisplayOrder(fields.displayOrder);
    let result: Awaited<ReturnType<typeof create>> | Awaited<ReturnType<typeof update>> | undefined;
    if (service === undefined) {
      result = await create(buildCreate(fields, priceMinor, displayOrder));
    } else {
      const patch = buildPatch(service, fields, priceMinor, displayOrder);
      // The API refuses an empty patch; saving an untouched form is just closing it.
      if (Object.keys(patch).length > 0) result = await update({ id: service.id, patch });
    }

    if (result?.error === undefined) onClose();
    else setErrors(serverFieldErrors(result.error));
  }

  return (
    <Dialog
      title={service === undefined ? text.createServiceTitle : text.editServiceTitle}
      onClose={onClose}
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {errors.form !== undefined && <Banner tone="danger" message={errors.form} />}
        <SelectField
          label={text.category}
          error={errors.categoryId}
          value={fields.categoryId}
          options={categories.map((category) => ({
            value: category.id,
            label: category.isActive
              ? azName(category.name)
              : `${azName(category.name)} (${catalogueCopy.inactive})`,
          }))}
          onChange={(event) => {
            setFields({ ...fields, categoryId: event.target.value });
          }}
        />
        <CommonFieldsEditor
          fields={fields}
          errors={errors}
          onChange={(common) => {
            setFields({ ...fields, ...common });
          }}
        />
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label={text.pricingKind}
            value={fields.pricingKind}
            options={[
              { value: 'fixed', label: text.pricingFixed },
              { value: 'inspection', label: text.pricingInspection },
            ]}
            onChange={(event) => {
              setFields({ ...fields, pricingKind: event.target.value as ServicePricingKind });
            }}
          />
          <TextField
            label={text.price}
            hint={inspection ? text.priceNotApplicable : text.priceHint}
            error={inspection ? undefined : errors.price}
            value={inspection ? '' : fields.price}
            disabled={inspection}
            inputMode="decimal"
            onChange={(event) => {
              setFields({ ...fields, price: event.target.value });
            }}
          />
        </div>
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

function buildCreate(
  fields: ServiceFields,
  priceMinor: number | null,
  displayOrder: number | undefined,
): ServiceCreate {
  return {
    categoryId: fields.categoryId,
    slug: fields.slug.trim(),
    name: nameFrom(fields),
    pricingKind: fields.pricingKind,
    ...(priceMinor === null ? {} : { basePriceMinor: priceMinor }),
    isActive: fields.isActive,
    ...(displayOrder === undefined ? {} : { displayOrder }),
  };
}

function buildPatch(
  service: AdminCatalogueService,
  fields: ServiceFields,
  priceMinor: number | null,
  displayOrder: number | undefined,
): ServicePatch {
  const slug = fields.slug.trim();
  const name = nameFrom(fields, service.name);
  const pricingChanged =
    fields.pricingKind !== service.pricingKind || priceMinor !== service.basePriceMinor;
  return {
    ...(fields.categoryId === service.categoryId ? {} : { categoryId: fields.categoryId }),
    ...(slug === service.slug ? {} : { slug }),
    ...(sameName(name, service.name) ? {} : { name }),
    // Kind and price travel together: the API checks the pair, and a change
    // to either alone could leave a fixed service without a price.
    ...(pricingChanged ? { pricingKind: fields.pricingKind, basePriceMinor: priceMinor } : {}),
    ...(displayOrder === undefined || displayOrder === service.displayOrder
      ? {}
      : { displayOrder }),
    ...(fields.isActive === service.isActive ? {} : { isActive: fields.isActive }),
  };
}
