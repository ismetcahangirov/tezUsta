import { Checkbox } from '../../components/Checkbox';
import { TextField } from '../../components/TextField';
import { catalogueCopy } from './copy';
import type { CommonFields, FieldErrors } from './form-support';

export interface CommonFieldsEditorProps {
  fields: CommonFields;
  errors: FieldErrors;
  onChange: (next: CommonFields) => void;
}

/** Slug, the three names, display order and the active switch — shared by both forms. */
export function CommonFieldsEditor({ fields, errors, onChange }: CommonFieldsEditorProps) {
  const set = <K extends keyof CommonFields>(key: K, value: CommonFields[K]) => {
    onChange({ ...fields, [key]: value });
  };
  const text = catalogueCopy.form;

  return (
    <>
      <TextField
        label={text.slug}
        hint={text.slugHint}
        error={errors.slug}
        value={fields.slug}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          set('slug', event.target.value);
        }}
      />
      <TextField
        label={text.nameAz}
        error={errors.nameAz}
        value={fields.nameAz}
        lang="az"
        onChange={(event) => {
          set('nameAz', event.target.value);
        }}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label={text.nameEn}
          error={errors.nameEn}
          value={fields.nameEn}
          lang="en"
          onChange={(event) => {
            set('nameEn', event.target.value);
          }}
        />
        <TextField
          label={text.nameRu}
          error={errors.nameRu}
          value={fields.nameRu}
          lang="ru"
          onChange={(event) => {
            set('nameRu', event.target.value);
          }}
        />
      </div>
      <TextField
        label={text.displayOrder}
        hint={text.displayOrderHint}
        error={errors.displayOrder}
        value={fields.displayOrder}
        inputMode="numeric"
        onChange={(event) => {
          set('displayOrder', event.target.value);
        }}
      />
      <Checkbox
        label={text.active}
        checked={fields.isActive}
        onChange={(event) => {
          set('isActive', event.target.checked);
        }}
      />
    </>
  );
}
