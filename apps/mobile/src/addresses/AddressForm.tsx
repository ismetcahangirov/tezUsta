import type { Address } from '@tezusta/types';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, Sheet, Text, TextField } from '../components';
import { ADDRESSES_COPY as copy } from './addresses-copy';
import { envelopeOf, fieldErrorsOf, statusOf } from './addresses-errors';
import { useForwardGeocodeMutation } from './addresses-endpoints';

export interface AddressFormValues {
  readonly label: string | null;
  readonly formattedAddress: string;
  readonly building: string | null;
  readonly entrance: string | null;
  readonly floor: string | null;
  readonly apartment: string | null;
  readonly landmarkNote: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

export interface AddressFormProps {
  mode: 'add' | 'edit';
  /** Prefills every field, including a coordinate the text is already resolved for. */
  initial?: Address;
  /** True while the caller's own create/update mutation is in flight. */
  submitting: boolean;
  /** That mutation's `error`, surfaced against the field it names, or as a banner. */
  error?: unknown;
  onSubmit: (values: AddressFormValues) => void;
  onCancel: () => void;
}

/** Empty input means "not provided"; `Address`'s optional fields are `null`, not `''`. */
function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Add or edit one saved address: free-text entry, forward-geocoded through
 * `/geocode/forward`, plus the Baku addressing detail `Address` carries.
 *
 * **No map, and no reverse geocoding.** `create` and `update` both require a
 * coordinate (`addresses.schema.ts`'s `latitude`/`longitude` are not
 * optional), so this form cannot skip geocoding — but it never asks for
 * location permission to get there. The customer types an address, this form
 * asks `/geocode/forward` for a point, and the typed text is what gets saved
 * as `formattedAddress` — forward geocoding's `ok` case returns only a
 * coordinate, never a resolved address line (`GeocodedLocation`), so there is
 * nothing here to overwrite what the customer wrote. Denial of a permission
 * this screen never requests cannot dead-end it, and issue #90 explicitly
 * allows shipping manual entry plus forward geocoding alone.
 *
 * **A coordinate is tied to the exact text it was resolved for.** `geocodedFor`
 * holds that text; editing the address field away from it invalidates the
 * coordinate immediately; rather than silently keep saving whatever was last
 * found. That is what keeps a customer from typing over yesterday's find and
 * saving today's words at yesterday's pin.
 */
export function AddressForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: AddressFormProps): React.JSX.Element {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [addressText, setAddressText] = useState(initial?.formattedAddress ?? '');
  const [building, setBuilding] = useState(initial?.building ?? '');
  const [entrance, setEntrance] = useState(initial?.entrance ?? '');
  const [floor, setFloor] = useState(initial?.floor ?? '');
  const [apartment, setApartment] = useState(initial?.apartment ?? '');
  const [landmarkNote, setLandmarkNote] = useState(initial?.landmarkNote ?? '');

  const [geocodedFor, setGeocodedFor] = useState<string | null>(
    initial === undefined ? null : initial.formattedAddress,
  );
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(
    initial === undefined ? null : { latitude: initial.latitude, longitude: initial.longitude },
  );

  const [forwardGeocode, geocodeResult] = useForwardGeocodeMutation();

  const trimmedAddress = addressText.trim();
  const isGeocoded = trimmedAddress !== '' && geocodedFor === trimmedAddress && coords !== null;

  const fieldErrors = fieldErrorsOf(error);
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  const status = statusOf(error);
  // A 422 with mapped field errors is fully explained inline; anything else
  // gets one banner, including a 422 whose issues named a field this form has
  // no control for.
  const showBanner = error !== undefined && !(status === 422 && hasFieldErrors);
  const bannerMessage =
    status === 409
      ? copy.tooManyAddresses
      : status === 404
        ? copy.notFoundError
        : isTransportFailure(status)
          ? copy.offlineError
          : (envelopeOf(error)?.message ?? copy.saveError);

  const geocodeStatus = geocodeResult.data?.status;
  const addressFieldError =
    fieldErrors['formattedAddress'] ??
    (geocodeStatus === 'no-result'
      ? copy.geocodeNoResult
      : geocodeStatus === 'unavailable' || geocodeResult.isError
        ? copy.geocodeUnavailable
        : undefined);

  async function handleFindAddress(): Promise<void> {
    if (trimmedAddress === '') {
      return;
    }
    try {
      const result = await forwardGeocode(trimmedAddress).unwrap();
      if (result.status === 'ok') {
        setCoords({ latitude: result.latitude, longitude: result.longitude });
        setGeocodedFor(trimmedAddress);
      } else {
        setCoords(null);
        setGeocodedFor(null);
      }
    } catch {
      // geocodeResult.error / .isError already carries this for rendering —
      // the typed text is untouched either way, which is what keeps this
      // recoverable rather than a dead end.
      setCoords(null);
      setGeocodedFor(null);
    }
  }

  function handleSubmit(): void {
    if (!isGeocoded || coords === null) {
      return;
    }
    onSubmit({
      label: textOrNull(label),
      formattedAddress: trimmedAddress,
      building: textOrNull(building),
      entrance: textOrNull(entrance),
      floor: textOrNull(floor),
      apartment: textOrNull(apartment),
      landmarkNote: textOrNull(landmarkNote),
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
  }

  return (
    <Sheet title={mode === 'add' ? copy.formTitleAdd : copy.formTitleEdit}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-4 pb-2">
          {showBanner && <Banner tone="danger" message={bannerMessage} />}

          <TextField
            label={copy.labelField}
            value={label}
            editable={!submitting}
            onChangeText={setLabel}
          />

          <View className="gap-2">
            <TextField
              label={copy.addressField}
              value={addressText}
              editable={!submitting}
              onChangeText={setAddressText}
              {...(addressFieldError !== undefined ? { error: addressFieldError } : {})}
            />
            <Button
              label={copy.findAddressAction}
              variant="secondary"
              size="sm"
              loading={geocodeResult.isLoading}
              disabled={submitting || trimmedAddress === ''}
              onPress={() => {
                void handleFindAddress();
              }}
            />
            {isGeocoded && (
              <Text variant="footnote" tone="muted">
                {copy.addressFound}
              </Text>
            )}
          </View>

          <TextField
            label={copy.buildingField}
            value={building}
            editable={!submitting}
            onChangeText={setBuilding}
            {...(fieldErrors['building'] !== undefined ? { error: fieldErrors['building'] } : {})}
          />
          <TextField
            label={copy.entranceField}
            value={entrance}
            editable={!submitting}
            onChangeText={setEntrance}
            {...(fieldErrors['entrance'] !== undefined ? { error: fieldErrors['entrance'] } : {})}
          />
          <TextField
            label={copy.floorField}
            value={floor}
            editable={!submitting}
            onChangeText={setFloor}
            {...(fieldErrors['floor'] !== undefined ? { error: fieldErrors['floor'] } : {})}
          />
          <TextField
            label={copy.apartmentField}
            value={apartment}
            editable={!submitting}
            onChangeText={setApartment}
            {...(fieldErrors['apartment'] !== undefined ? { error: fieldErrors['apartment'] } : {})}
          />
          <TextField
            label={copy.landmarkField}
            value={landmarkNote}
            editable={!submitting}
            onChangeText={setLandmarkNote}
            {...(fieldErrors['landmarkNote'] !== undefined
              ? { error: fieldErrors['landmarkNote'] }
              : {})}
          />

          <View className="flex-row gap-3 pt-2">
            <Button
              label={copy.cancel}
              variant="secondary"
              disabled={submitting}
              className="flex-1"
              onPress={onCancel}
            />
            <Button
              label={copy.save}
              variant="accent"
              loading={submitting}
              disabled={submitting || !isGeocoded}
              className="flex-1"
              onPress={handleSubmit}
            />
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}
