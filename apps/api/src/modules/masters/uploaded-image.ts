import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import {
  IMAGE_SIGNATURE_BYTES,
  isHeicSignature,
  sniffImageContentType,
} from '../../infra/storage/image-content-type';
import type { AllowedImageContentType } from '../../infra/storage/image-content-type';
import type { StorageProvider } from '../../infra/storage/storage.types';

/**
 * A master's photo uploads — portfolio photos (#308) and the avatar (#309) —
 * share one confirm step and one set of refusals. They live with the masters
 * module, which both the portfolio and the avatar depend on.
 */

/**
 * Only an active, verified master writes to a portfolio (ADR-0045 § 3). 403:
 * the caller is who they say, and the platform says no. `details` carries the
 * verification status, or `null` for a caller with no master profile, so the
 * app can say which.
 */
export class PortfolioMasterNotActiveError extends AppError {
  constructor(verificationStatus: string | null) {
    super(
      ERROR_CODES.PORTFOLIO_MASTER_NOT_ACTIVE,
      'Only a verified, active master can change their portfolio or avatar.',
      403,
      { verificationStatus },
    );
    this.name = 'PortfolioMasterNotActiveError';
    Object.setPrototypeOf(this, PortfolioMasterNotActiveError.prototype);
  }
}

export class PortfolioMediaNotUploadedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_NOT_UPLOADED,
      'The photo has not arrived yet. Upload it to the URL from the presign step, then confirm.',
      409,
    );
    this.name = 'PortfolioMediaNotUploadedError';
    Object.setPrototypeOf(this, PortfolioMediaNotUploadedError.prototype);
  }
}

export class PortfolioMediaAlreadyConfirmedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_ALREADY_CONFIRMED,
      'This photo has already been confirmed.',
      409,
    );
    this.name = 'PortfolioMediaAlreadyConfirmedError';
    Object.setPrototypeOf(this, PortfolioMediaAlreadyConfirmedError.prototype);
  }
}

/** 422, as `PhotoTooLargeError` is: the status table has no 413 for a stored object. */
export class PortfolioMediaTooLargeError extends AppError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(ERROR_CODES.PORTFOLIO_MEDIA_TOO_LARGE, 'That photo is too large.', 422, {
      sizeBytes,
      maxBytes,
    });
    this.name = 'PortfolioMediaTooLargeError';
    Object.setPrototypeOf(this, PortfolioMediaTooLargeError.prototype);
  }
}

export class PortfolioMediaHeicUnsupportedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_HEIC_UNSUPPORTED,
      'HEIC photos are not supported. Send it as a JPEG.',
      422,
    );
    this.name = 'PortfolioMediaHeicUnsupportedError';
    Object.setPrototypeOf(this, PortfolioMediaHeicUnsupportedError.prototype);
  }
}

/** Which signature was actually seen is not told, as `PhotoContentMismatchError` does not tell it. */
export class PortfolioMediaContentMismatchError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_CONTENT_MISMATCH,
      'That file is not a JPEG, PNG or WebP image, or does not match the type it was uploaded as.',
      422,
    );
    this.name = 'PortfolioMediaContentMismatchError';
    Object.setPrototypeOf(this, PortfolioMediaContentMismatchError.prototype);
  }
}

/** What a confirmed upload turned out to be. */
export interface VerifiedImage {
  readonly sizeBytes: number;
  readonly contentType: AllowedImageContentType;
}

/**
 * Checks an uploaded photo where it landed, `OrderPhotosService#confirmUpload`'s
 * order and reasoning: the stored size against the cap (one `HeadObject`,
 * before anything is read), then HEIC, then the leading bytes against the
 * type the URL was signed for. A refused object is deleted — the presigned
 * URL still works, so the caller keeps its row for a retry — and `onRefused`
 * names why, for the caller's log line.
 */
export async function verifyUploadedImage(input: {
  readonly storage: StorageProvider;
  readonly key: string;
  readonly declaredContentType: string;
  readonly maxBytes: number;
  readonly onRefused: (reason: string) => void;
}): Promise<VerifiedImage> {
  const { storage, key } = input;
  const head = await storage.head(key);
  if (head === undefined) {
    throw new PortfolioMediaNotUploadedError();
  }

  const refuse = async (reason: string): Promise<void> => {
    await storage.delete(key);
    input.onRefused(reason);
  };

  if (head.sizeBytes > input.maxBytes) {
    await refuse('oversize');
    throw new PortfolioMediaTooLargeError(head.sizeBytes, input.maxBytes);
  }

  const prefix = await storage.readPrefix(key, IMAGE_SIGNATURE_BYTES);
  if (prefix !== undefined && isHeicSignature(prefix)) {
    await refuse('heic');
    throw new PortfolioMediaHeicUnsupportedError();
  }
  const sniffed = prefix === undefined ? null : sniffImageContentType(prefix);
  if (sniffed === null || sniffed !== input.declaredContentType) {
    await refuse('content-mismatch');
    throw new PortfolioMediaContentMismatchError();
  }
  return { sizeBytes: head.sizeBytes, contentType: sniffed };
}
