import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AttachmentRefusal } from './message-attachments.repository';

/**
 * The send-time refusals for message photos (issue #181).
 *
 * The storage-side refusals — not uploaded yet, confirmed twice, too large,
 * not the bytes it claimed — are **not** redefined here: the confirm step
 * reuses `order-photos.service.ts`'s own error classes, so a client that
 * already handles a rejected order photo handles a rejected message photo with
 * the same code and the same wording. What is new is only what can go wrong
 * when a message *names* photos, and that lives in this file rather than in
 * `message-attachments.service.ts` because `conversations.service.ts` raises
 * it, and importing that service from there would be a cycle.
 */

/** A photo named on a message has not finished uploading — confirm it first. */
export class MessageAttachmentNotConfirmedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'A photo on this message has not finished uploading yet. Confirm it before sending.',
      409,
    );
    this.name = 'MessageAttachmentNotConfirmedError';
    Object.setPrototypeOf(this, MessageAttachmentNotConfirmedError.prototype);
  }
}

/**
 * A photo named on a message has already been sent on another one. A photo
 * belongs to exactly one message, the way an order photo belongs to exactly one
 * order; sending it twice would make one row two pieces of evidence.
 */
export class MessageAttachmentAlreadySentError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'A photo on this message has already been sent.', 409);
    this.name = 'MessageAttachmentAlreadySentError';
    Object.setPrototypeOf(this, MessageAttachmentAlreadySentError.prototype);
  }
}

/**
 * The error a refused send answers with.
 *
 * **`not_found` is a plain 404**, the same answer as a stranger's order id: a
 * photo id from another conversation, or one the *other* party uploaded, must
 * be indistinguishable from one that does not exist, or the send endpoint
 * becomes a way to test which photo ids are real — `requireOwnPhoto`'s rule in
 * `order-photos.service.ts`, applied here.
 */
export function refuseAttachments(refusal: AttachmentRefusal): AppError {
  switch (refusal) {
    case 'not_found':
      return new NotFoundError();
    case 'not_confirmed':
      return new MessageAttachmentNotConfirmedError();
    case 'already_attached':
      return new MessageAttachmentAlreadySentError();
  }
}
