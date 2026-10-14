import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

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
      'Only a verified, active master can change a portfolio.',
      403,
      { verificationStatus },
    );
    this.name = 'PortfolioMasterNotActiveError';
    Object.setPrototypeOf(this, PortfolioMasterNotActiveError.prototype);
  }
}

export class PortfolioServiceNotOfferedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_SERVICE_NOT_OFFERED,
      'A post can be tagged only with a service you offer.',
      422,
    );
    this.name = 'PortfolioServiceNotOfferedError';
    Object.setPrototypeOf(this, PortfolioServiceNotOfferedError.prototype);
  }
}

export class PortfolioPostNotEditableError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_POST_NOT_EDITABLE,
      'This post can no longer be changed that way.',
      409,
    );
    this.name = 'PortfolioPostNotEditableError';
    Object.setPrototypeOf(this, PortfolioPostNotEditableError.prototype);
  }
}

export class PortfolioPostNotReadyError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_POST_NOT_READY,
      'Add at least one photo, and let every photo finish uploading, before publishing.',
      409,
    );
    this.name = 'PortfolioPostNotReadyError';
    Object.setPrototypeOf(this, PortfolioPostNotReadyError.prototype);
  }
}

export class PortfolioPostLimitExceededError extends AppError {
  constructor(maxPosts: number) {
    super(
      ERROR_CODES.PORTFOLIO_POST_LIMIT_EXCEEDED,
      `A portfolio holds at most ${String(maxPosts)} posts. Delete one to publish another.`,
      409,
      { maxPosts },
    );
    this.name = 'PortfolioPostLimitExceededError';
    Object.setPrototypeOf(this, PortfolioPostLimitExceededError.prototype);
  }
}

export class PortfolioMediaLimitExceededError extends AppError {
  constructor(maxItems: number) {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_LIMIT_EXCEEDED,
      `A post holds at most ${String(maxItems)} photos.`,
      409,
      { maxItems },
    );
    this.name = 'PortfolioMediaLimitExceededError';
    Object.setPrototypeOf(this, PortfolioMediaLimitExceededError.prototype);
  }
}

export class PortfolioMediaPositionTakenError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_MEDIA_POSITION_TAKEN,
      'Another photo is already in that place in the post.',
      409,
    );
    this.name = 'PortfolioMediaPositionTakenError';
    Object.setPrototypeOf(this, PortfolioMediaPositionTakenError.prototype);
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
