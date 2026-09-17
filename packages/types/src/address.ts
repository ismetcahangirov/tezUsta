/**
 * A saved customer address as the API returns it.
 *
 * **The structured fields are the point of this contract, not decoration.** A
 * coordinate is frequently not enough to find a door in Baku
 * (`docs/architecture/location-services.md` § Azerbaijani addresses): buildings
 * sit inside courtyards, one block has several entrances, and a master who
 * arrives with only a pin loses the time it takes to phone the customer and be
 * talked in. That is why `entrance`, `floor` and `apartment` are first-class
 * fields rather than something a customer is expected to type into a note.
 *
 * They are **strings, not numbers**, because that is what they are in this
 * market: an entrance is "2" but also "B", a floor is "5" but also "zirzəmi",
 * and an apartment is "48" but also "48A". A numeric column would force the
 * customer to lie or leave it blank, and a blank one is the problem this
 * contract exists to solve.
 *
 * Every field except `formattedAddress`, the coordinates and `isDefault` is
 * nullable: a customer who knows only the street is still better served by a
 * saved address than by nothing.
 *
 * **This is PII.** It is shown to a master only after they accept the order
 * (`docs/engineering/security.md` § PII and privacy), never while an order is
 * being broadcast — so nothing that returns this shape may be reachable by a
 * master browsing, only by the customer who owns it.
 */
export interface Address {
  readonly id: string;
  /** What the customer calls it — "Ev", "İş". Null when they did not say. */
  readonly label: string | null;
  /** One human-readable line, as a geocoder or the customer wrote it. */
  readonly formattedAddress: string;
  /** Building or block — "12B", "3-cü blok". */
  readonly building: string | null;
  /** Entrance — `giriş`, the подъезд of a Soviet-era block. */
  readonly entrance: string | null;
  readonly floor: string | null;
  readonly apartment: string | null;
  /** Free text: "Marketin yanı", "qırmızı qapı". */
  readonly landmarkNote: string | null;
  /** WGS 84 degrees. */
  readonly latitude: number;
  /** WGS 84 degrees. */
  readonly longitude: number;
  /**
   * Exactly one live address per customer carries this, enforced by a partial
   * unique index rather than by application code. A customer with at least one
   * address always has a default: the first one is promoted automatically, and
   * deleting the default promotes the oldest survivor.
   */
  readonly isDefault: boolean;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  /** ISO 8601, UTC. */
  readonly updatedAt: string;
}
