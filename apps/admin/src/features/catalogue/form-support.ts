import type { SerializedError } from '@reduxjs/toolkit';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

import { describeFailure } from '../../api/api-error';
import { validationIssuePaths } from '../../api/validation-issues';
import type { LocalizedName } from './api';
import { catalogueCopy } from './copy';

/**
 * What the category and service forms share: the fields, the client-side
 * checks (a mirror of `admin-catalogue.schema.ts`, so an obvious mistake is
 * caught before a round-trip — the server stays the authority), and the
 * mapping of the server's refusals back onto the fields.
 */

export type FieldName =
  'slug' | 'nameAz' | 'nameEn' | 'nameRu' | 'displayOrder' | 'categoryId' | 'price';

export type FieldErrors = Partial<Record<FieldName | 'form', string>>;

export interface CommonFields {
  slug: string;
  nameAz: string;
  nameEn: string;
  nameRu: string;
  displayOrder: string;
  isActive: boolean;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG = 64;
const MAX_NAME = 80;
const MAX_DISPLAY_ORDER = 1_000_000;

export function commonFieldsFrom(item?: {
  readonly slug: string;
  readonly name: Readonly<Record<string, string>>;
  readonly displayOrder: number;
  readonly isActive: boolean;
}): CommonFields {
  return {
    slug: item?.slug ?? '',
    nameAz: item?.name.az ?? '',
    nameEn: item?.name.en ?? '',
    nameRu: item?.name.ru ?? '',
    displayOrder: item === undefined ? '' : String(item.displayOrder),
    isActive: item?.isActive ?? true,
  };
}

export function checkCommonFields(fields: CommonFields): FieldErrors {
  const errors: FieldErrors = {};
  const slug = fields.slug.trim();
  if (slug.length === 0 || slug.length > MAX_SLUG || !SLUG.test(slug)) {
    errors.slug = catalogueCopy.form.slugInvalid;
  }
  if (fields.nameAz.trim().length === 0) errors.nameAz = catalogueCopy.form.nameAzRequired;
  else if (fields.nameAz.trim().length > MAX_NAME) errors.nameAz = catalogueCopy.form.nameTooLong;
  if (fields.nameEn.trim().length > MAX_NAME) errors.nameEn = catalogueCopy.form.nameTooLong;
  if (fields.nameRu.trim().length > MAX_NAME) errors.nameRu = catalogueCopy.form.nameTooLong;
  if (fields.displayOrder.trim() !== '' && parseDisplayOrder(fields.displayOrder) === undefined) {
    errors.displayOrder = catalogueCopy.form.displayOrderInvalid;
  }
  return errors;
}

export function parseDisplayOrder(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= MAX_DISPLAY_ORDER ? value : undefined;
}

/**
 * The localized name to send. Starts from the stored one so a language this
 * form does not edit (the API allows up to five) survives an edit; an
 * emptied optional language is dropped rather than sent blank.
 */
export function nameFrom(
  fields: CommonFields,
  original: Readonly<Record<string, string>> = {},
): LocalizedName {
  const edited: Record<string, string> = {
    az: fields.nameAz,
    en: fields.nameEn,
    ru: fields.nameRu,
  };
  const untouched = Object.entries(original).filter(([language]) => !(language in edited));
  const entered = Object.entries(edited)
    .map(([language, value]) => [language, value.trim()] as const)
    .filter(([language, value]) => language === 'az' || value !== '');
  return Object.fromEntries([...untouched, ...entered]) as LocalizedName;
}

export function sameName(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

/** The name the editor lists an item under: the Azerbaijani one, which the API requires. */
export function azName(name: Readonly<Record<string, string>>): string {
  return name.az ?? '';
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Which form field a dotted server path names. */
const PATH_FIELDS: readonly [RegExp, FieldName, string][] = [
  [/^slug$/, 'slug', catalogueCopy.form.slugInvalid],
  [/^name\.en$/, 'nameEn', catalogueCopy.form.nameTooLong],
  [/^name\.ru$/, 'nameRu', catalogueCopy.form.nameTooLong],
  [/^name(\..*)?$/, 'nameAz', catalogueCopy.form.nameInvalid],
  [/^displayOrder$/, 'displayOrder', catalogueCopy.form.displayOrderInvalid],
  [/^categoryId$/, 'categoryId', catalogueCopy.form.categoryInvalid],
  [/^(basePriceMinor|pricingKind)$/, 'price', catalogueCopy.form.priceRange],
];

/** The server's refusal, as messages on the fields it names. */
export function serverFieldErrors(
  error: FetchBaseQueryError | SerializedError | undefined,
): FieldErrors {
  const failure = describeFailure(error);
  if (failure === undefined) return {};
  if (failure.code === 'CATALOGUE_SLUG_TAKEN') return { slug: catalogueCopy.form.slugTaken };
  if (failure.status !== 422) return { form: catalogueCopy.form.unexpected };

  const errors: FieldErrors = {};
  for (const path of validationIssuePaths(error)) {
    const match = PATH_FIELDS.find(([pattern]) => pattern.test(path));
    if (match !== undefined) errors[match[1]] ??= match[2];
  }
  return hasErrors(errors) ? errors : { form: catalogueCopy.form.rejected };
}
