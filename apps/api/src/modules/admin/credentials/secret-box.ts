import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for small admin secrets (ADR-0043 § 2): the stored TOTP secret
 * and the short-lived pending-enrolment blob.
 *
 *     v1.<iv, base64url>.<ciphertext, base64url>.<tag, base64url>
 *
 * Every seal takes a **context** string bound in as additional authenticated
 * data — the admin id for a stored secret, the invitation id for a pending
 * one. A ciphertext copied onto another row, or a pending blob replayed
 * against another invitation, fails authentication instead of decrypting.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
    Object.setPrototypeOf(this, SecretBoxError.prototype);
  }
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(`The key must be ${String(KEY_BYTES)} bytes.`);
    }
    this.key = Buffer.from(key);
  }

  seal(plaintext: Buffer, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /** Throws `SecretBoxError` on any tampering, wrong context or wrong key. */
  open(sealed: string, context: string): Buffer {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretBoxError('Unrecognised sealed value.');
    }
    const [, ivText, ciphertextText, tagText] = parts as [string, string, string, string];
    try {
      // `authTagLength` pinned: GCM otherwise accepts a truncated tag, and a
      // four-byte tag is forgeable by brute force.
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'), {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, 'base64url')),
        decipher.final(),
      ]);
    } catch {
      throw new SecretBoxError('The sealed value failed authentication.');
    }
  }
}
