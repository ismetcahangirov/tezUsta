import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

/**
 * A position report the server refused as physically impossible (issue #274,
 * [ADR-0044](docs/decisions/ADR-0044-location-plausibility.md)).
 *
 * **No details, deliberately.** The distance, the elapsed time and the implied
 * speed would each be derived from two coordinates, and an error envelope is
 * logged, proxied and cached in places a position must never reach
 * (CLAUDE.md §11). They would also be a spoofer's calibration tool: "you were
 * 3 km/h too fast" is a map of exactly where the line is.
 */
export class LocationImplausibleError extends AppError {
  constructor() {
    super(
      ERROR_CODES.LOCATION_IMPLAUSIBLE,
      'This position is too far from your previous one to have been reached in the time since.',
      422,
    );
    this.name = 'LocationImplausibleError';
    Object.setPrototypeOf(this, LocationImplausibleError.prototype);
  }
}
