# Public media bucket runbook

How to set up the public bucket that serves master portfolio photos, the
lifecycle rule that backs up the upload sweeps, and the token the API purges the
CDN with. The policy is in
[ADR-0045](../decisions/ADR-0045-master-portfolio.md) § 5 and § 6. The code is
`apps/api/src/infra/storage/` and `apps/api/src/infra/cdn/` (issue #304).

Every step here is bucket or account configuration, not code. That is why it is
a runbook and not a migration. The steps belong to the owner, because each one
needs the Cloudflare account.

Until they are done, development and tests run against the stub storage and the
stub purger. **Production does not boot without them.** Both stubs refuse
`NODE_ENV=production`, and `STORAGE_PROVIDER=s3` refuses to start without the
public bucket. So the first production deploy waits on the media domain, which
CLAUDE.md § 1 lists as an open owner decision.

## 1. What exists after setup

| Bucket                         | Holds                                         | Read through                                   |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `S3_BUCKET` (private, exists)  | every client upload, including raw photos     | short-lived presigned URLs only (ADR-0024)     |
| `S3_PUBLIC_MEDIA_BUCKET` (new) | WebP renditions the server made, nothing else | `MEDIA_PUBLIC_BASE_URL`, unsigned, via the CDN |

- A raw portfolio photo lands in the **private** bucket under
  `portfolio-incoming/`, and a raw avatar under `avatar-incoming/` (#309).
- The media worker (#305) reads it, writes the renditions to the **public**
  bucket, and deletes the raw object.
- A client never writes to the public bucket. There is no presigned URL for it.

## 2. Owner actions

### 2.1 Create the public bucket

In the Cloudflare dashboard, go to **R2 object storage → Create bucket**. Use
the same account and location as the private bucket. The name is yours to
choose, for example `tezusta-media`. It becomes `S3_PUBLIC_MEDIA_BUCKET`.

### 2.2 Attach the custom domain, and keep `r2.dev` off

1. Open the bucket's **Settings**. Under **Custom Domains**, select **Add**.
2. Enter the media domain, for example `media.tezusta.az`, and select
   **Continue**.
3. Review the DNS record, then select **Connect Domain**. The status moves from
   **Initializing** to **Active** within a few minutes.

The domain must be a zone in the **same Cloudflare account** as the bucket.
`https://<that domain>` becomes `MEDIA_PUBLIC_BASE_URL`.

Under **Public Development URL**, leave the bucket **disabled**. Cloudflare
documents `r2.dev` as rate-limited and for development only. The API refuses an
`r2.dev` base URL under `NODE_ENV=production`.

Cloudflare caches `.webp` on a custom domain by default, and honours the
object's `Cache-Control` (`public, max-age=31536000, immutable`). No cache rule
is needed.

### 2.3 Let the API's R2 token write to both buckets

The API uses one key pair (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) for both
buckets. Edit the R2 API token, or create a new one, so that it has
**Object Read & Write** on the private bucket **and** the public one, and on
no other bucket.

### 2.4 Add the lifecycle rules on the **private** bucket

These three rules expire raw uploads after one day: abandoned portfolio photos
and avatars, and order problem photos. They are a backstop for anything the
sweeps (#311) miss, because a raw photo carries GPS (ADR-0045 § 5).

The third rule covers `orders/photos/`, where an order problem photo lands
before it is re-encoded (#318). Within seconds, its re-encoded copy replaces
it under `order-photos/`, and the upload is deleted. Anything still under
`orders/photos/` a day later is an upload whose delete failed, or one no row
names any more.

Dashboard: open the private bucket, then **Settings → Object Lifecycle Rules →
Add rule**. Set the prefix to `portfolio-incoming/` and expire objects after 1
day. Add a second rule the same way for `avatar-incoming/`, and a third for
`orders/photos/`.

Or with Wrangler, run this against the private bucket's name:

```sh
npx wrangler r2 bucket lifecycle add tezusta-uploads portfolio-incoming-expiry portfolio-incoming/ --expire-days 1
npx wrangler r2 bucket lifecycle add tezusta-uploads avatar-incoming-expiry avatar-incoming/ --expire-days 1
npx wrangler r2 bucket lifecycle add tezusta-uploads order-photo-upload-expiry orders/photos/ --expire-days 1
```

Cloudflare removes an expired object within about 24 hours of its expiry, so a
raw upload lives at most about two days. The sweeps remove it within the hour.
The rules go on the private bucket only. The public bucket holds no raw
uploads, and its renditions are deleted when their post is.

### 2.5 Create the purge token

Go to **My Profile → API Tokens → Create Token → Custom token**.

- **Permissions:** Zone → Cache Purge → Purge.
- **Zone resources:** Include → Specific zone → the media domain's zone.

Nothing else. The token goes in `CLOUDFLARE_PURGE_API_TOKEN`, which is a
secret. The zone's id is shown on its **Overview** page and goes in
`CLOUDFLARE_ZONE_ID`, which is not a secret.

## 3. Environment

```sh
STORAGE_PROVIDER=s3
S3_PUBLIC_MEDIA_BUCKET=tezusta-media
MEDIA_PUBLIC_BASE_URL=https://media.tezusta.az
CDN_PURGE_PROVIDER=cloudflare
CLOUDFLARE_ZONE_ID=<32 hex characters>
CLOUDFLARE_PURGE_API_TOKEN=<from 2.5, from the secret store>
```

The API refuses to boot if any of these is missing:

- `STORAGE_PROVIDER=s3` without the public bucket or its domain;
- `CDN_PURGE_PROVIDER=cloudflare` without the zone or the token;
- either stub under `NODE_ENV=production`.

## 4. Checks after setup

Unit tests can't prove these, because they need the real bucket and zone. Run
them once, by hand, after section 2. They go through the API's own provider
code, not a hand upload, because the code is what the checks are for. The S3
SDK's request checksums and path-style addressing are exactly what could behave
differently on R2 than in a test.

From `apps/api`, with the production environment from section 3 loaded, save
this as a scratch file outside the repository, for example
`/tmp/check-media.mts`, and run `pnpm exec tsx /tmp/check-media.mts`:

```ts
import { writeFile } from 'node:fs/promises';

import { CloudflareCdnPurger } from './src/infra/cdn/cloudflare-cdn-purger';
import { parseEnv } from './src/infra/config/parse-env';
import { S3StorageProvider } from './src/infra/storage/s3-storage.provider';
import { requireS3StorageConfig } from './src/infra/storage/storage.config';
import { PUBLIC_MEDIA_CACHE_CONTROL } from './src/infra/storage/storage.types';

const config = parseEnv(process.env);
const storage = new S3StorageProvider(requireS3StorageConfig(config));
if (config.cdn.purgeProvider !== 'cloudflare') throw new Error('set CDN_PURGE_PROVIDER');
const purger = new CloudflareCdnPurger(config.cdn.cloudflare);

const key = `checks/${crypto.randomUUID()}/probe.webp`;
await writeFile('/tmp/probe.webp', 'probe');
await storage.putPublic({
  key,
  filePath: '/tmp/probe.webp',
  contentType: 'image/webp',
  cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
});
const url = storage.publicUrl(key);
console.log('public:', (await fetch(url)).status, url);
await storage.deletePublic([key]);
await purger.purgeUrls([url]);
console.log('deleted and purged; re-check the URL in a minute');
```

Use your own absolute paths for the imports if the file is outside `apps/api`.
Then check:

1. **A rendition is public and immutable.** The script printed `public: 200`.
   Before the delete, `curl -I <url>` shows
   `cache-control: public, max-age=31536000, immutable` and no signature in the
   URL.
2. **The private bucket is still private.** Request any object in the private
   bucket on its S3 endpoint with no signature. Expect a refusal, never a
   `200`.
3. **Delete and purge.** The script finished without an error, so R2 accepted
   `DeleteObjects` and Cloudflare accepted the purge. Within a minute,
   `curl -I <url>` answers `404`.
