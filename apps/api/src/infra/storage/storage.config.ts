import type { AppConfig } from '../config/app-config.types';
import type { S3StorageConfig } from './s3-storage.provider';

/**
 * Thrown from the provider factory when `STORAGE_PROVIDER=s3` but the
 * connection details are not all there.
 *
 * Surfaces during `NestFactory.create`, the same fail-fast path
 * `MissingOtpCodePepperError` and `MissingAuthSecretError` take, so an
 * operator meets one shape of startup error rather than three.
 *
 * Booting anyway is the option not worth having. Every endpoint would come up
 * healthy, a master would be handed a presigned URL built from `undefined`,
 * and the failure would surface as a broken upload on somebody's phone rather
 * than as a deploy that stopped and named the variable.
 */
export class IncompleteS3StorageConfigError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `STORAGE_PROVIDER=s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not ` +
        'set. S3-compatible storage needs an endpoint, a region, a bucket and a key pair ' +
        '(ADR-0005, ADR-0024). Set them in the environment, or use STORAGE_PROVIDER=stub ' +
        'outside production.',
    );
    this.name = 'IncompleteS3StorageConfigError';
    Object.setPrototypeOf(this, IncompleteS3StorageConfigError.prototype);
  }
}

/**
 * The S3 connection details, **proven present** rather than typed
 * `string | undefined`.
 *
 * `AppConfig.storage.s3*` are all optional because EPIC 1 shipped long before
 * anything uploaded a byte, and `app-config.types.ts` states the rule that
 * follows: the module that first needs a value fails its own startup when it
 * is still missing. This is that module.
 */
export function requireS3StorageConfig(config: AppConfig): S3StorageConfig {
  const candidates = {
    S3_ENDPOINT: config.storage.s3Endpoint,
    S3_REGION: config.storage.s3Region,
    S3_BUCKET: config.storage.s3Bucket,
    S3_ACCESS_KEY_ID: config.storage.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: config.storage.s3SecretAccessKey,
  };

  const missing = Object.entries(candidates)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (missing.length > 0) {
    // Every missing variable at once. Reporting the first would make an
    // operator restart the deploy five times to discover five names.
    throw new IncompleteS3StorageConfigError(missing);
  }

  return {
    endpoint: candidates.S3_ENDPOINT as string,
    region: candidates.S3_REGION as string,
    bucket: candidates.S3_BUCKET as string,
    accessKeyId: candidates.S3_ACCESS_KEY_ID as string,
    secretAccessKey: candidates.S3_SECRET_ACCESS_KEY as string,
  };
}
