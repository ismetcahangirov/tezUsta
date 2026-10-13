# Admin bootstrap runbook

How the first `super_admin` comes to exist in a real environment, what to do
with their credentials, and how to rotate the key that protects every admin's
authenticator. The policy is in
[ADR-0043](../decisions/ADR-0043-admin-panel-policy.md) § 3. How the panel is
served is in [ADR-0052](../decisions/ADR-0052-serving-the-admin-panel.md).

Nobody needs this until a real environment exists (EPIC 17). It is written now
so that the first person to run it does not improvise.

## 1. Before you start

- The API is deployed from a commit whose migrations have run. The panel's
  image (`apps/admin/Dockerfile`) is in front of it.
- These are set in the API's environment:
  - `NODE_ENV=production`;
  - `ADMIN_SETUP_LINK_BASE_URL`, the panel's https origin, for example
    `https://ops.tezusta.az`;
  - `ADMIN_TOTP_ENCRYPTION_KEY`, from `openssl rand -base64 32`, held in the
    host's secret store and nowhere else;
  - `TRUST_PROXY`, the proxy's own address or CIDR (ADR-0052 § 5).
- You have a shell where the API's build and its environment are available: a
  one-off container from the API's image, or the host itself.
- The person who will be the first `super_admin` is with you, with their phone
  and an authenticator app installed.

## 2. Create the first super_admin

From the API's directory, with its environment loaded:

```bash
node dist/modules/admin/admin-bootstrap.cli.js --email aysel@tezusta.az --name "Aysel Mammadova"
```

`pnpm --filter api admin:bootstrap --email … --name …` (no `--`: pnpm 11 would pass it on as an argument) runs the same file
from the repository root. The command:

- refuses if a `super_admin` already exists;
- creates the account with no password and no authenticator;
- prints a **single-use setup link, valid 24 hours**. It is not stored and is
  not shown again.

## 3. Hand the link over and complete setup

1. Give the link to the person **in person or over a channel that does not
   keep it**. Never email it, never paste it into a ticket or chat history, and
   never screenshot it. The token is in the URL's `#` fragment, so it never
   reaches a server log, but it is still a credential.
2. They open it on their own machine. The page shows a QR code and the key in
   text. They scan it into their authenticator and enter a code.
3. They choose a password in their password manager: a passphrase of at least
   12 characters that they use nowhere else.
4. They sign in at the panel's origin with their email, password and a fresh
   code.

If the link expired or was lost, run
`admin-bootstrap.cli.js --reissue <email>`. It works only for an active
`super_admin`, and it replaces their password and authenticator.

## 4. Invite a second super_admin at once

ADR-0043 recommends at least two. With one, a lost phone means server access to
recover. With two, it means a minute in the panel.

1. The first `super_admin` opens **Admins → Invite**, gives the email and name,
   and ticks `super_admin`.
2. The one-time link is shown once. Hand it over as in § 3.
3. Once both can sign in, invite everyone else with the roles they need. No one
   gets `super_admin` "to be safe".

## 5. Rotate `ADMIN_TOTP_ENCRYPTION_KEY`

The key encrypts every admin's authenticator secret at rest (AES-256-GCM). The
API holds **one** key; there is no dual-key decryption. Changing the key
therefore makes every enrolled authenticator unreadable. Every admin enrols
again, and the sign-in form refuses them until they do.

Rotate when the key may have leaked: a host compromise, an exposed environment
dump, or a person with access to it leaving. A rotation is a planned re-enrolment:

1. Tell the admins it is happening and when.
2. Generate a new key with `openssl rand -base64 32`. Put it in the secret
   store, replacing the old one, and redeploy the API.
3. Run `admin-bootstrap.cli.js --reissue <email>` for one `super_admin`, and
   complete setup with them as in § 3.
4. That `super_admin` uses **Admins → Reset second factor** on every other
   admin, and hands each one-time link over as in § 3.
5. Destroy the old key. Nothing reads it any more.

## 6. A production-like run on a laptop

This is the same image and the same smoke test CI runs, against a throwaway
database. Docker Compose must be up (`docker compose up -d`).

```bash
# A throwaway database for the run
docker compose exec -T postgres psql -U tezusta -d tezusta -c "create database tezusta_smoke"

# The API, built and migrated, with a smoke admin
pnpm --filter api build
cd apps/api
export DATABASE_URL=postgresql://tezusta:tezusta@localhost:15432/tezusta_smoke NODE_ENV=test
# From apps/api the API reads apps/api/.env, not the root one. Without it, set
# what it needs the way CI does:
export REDIS_URL=redis://localhost:6379 \
  JWT_ACCESS_SECRET=local-only-access-secret-0123456789abcdefghijk \
  JWT_REFRESH_SECRET=local-only-refresh-secret-zyxwvutsrqponmlkjih
node dist/infra/database/migrate.js
node dist/modules/admin/admin-bootstrap.cli.js --email smoke@tezusta.test --name Smoke   # keep the link
node dist/main.js &          # port 3000

# The panel's image in front of it, on http://127.0.0.1:8080
cd ../..
docker compose --profile prodlike up -d --build admin-proxy

# The smoke test through the proxy
SMOKE_BASE_URL=http://127.0.0.1:8080 SMOKE_SETUP_LINK='<the link>' pnpm --filter admin test:smoke
```

`NODE_ENV=test` makes the cookies `Secure`, which is the attribute the smoke
test checks. Drop the database afterwards. The setup link opens only that
database.
