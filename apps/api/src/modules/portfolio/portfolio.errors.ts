import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

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
