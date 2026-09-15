/**
 * Loads a `.env` file into `process.env` for local development, using Node
 * 24's native `process.loadEnvFile()` — no `dotenv`, no `@nestjs/config`
 * (issue #23 explicitly forbids adding either).
 *
 * A missing `.env` is not fatal: a fresh checkout and CI both run without one
 * (CI injects the handful of variables it needs directly —
 * `.github/workflows/ci.yml`), and `parseEnv` is what actually enforces which
 * variables must be present, not this loader.
 *
 * Only runs outside production: in production the environment comes from the
 * deployment platform, never from a file baked into or mounted alongside the
 * running process (`docs/architecture/backend-architecture.md` § Configuration).
 */
export function loadEnvFileIfPresent(): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  try {
    process.loadEnvFile();
  } catch {
    // No .env file present. Fine — parseEnv reports anything actually
    // missing that matters, with the process still failing fast.
  }
}
