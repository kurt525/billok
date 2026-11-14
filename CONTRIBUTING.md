# Contributing to ShareTab

Thanks for your interest in contributing! Here's everything you need to get started.

## Dev Environment Setup

### Prerequisites

- Node.js 22 (the version CI and the Docker image use)
- npm 10+
- Git

### Install dependencies

```bash
git clone https://github.com/sw-carlos-cristobal/sharetab.git
cd sharetab
npm install
npx prisma generate
```

The committed `.npmrc` sets `legacy-peer-deps=true` (CI and the Dockerfile pass `--legacy-peer-deps` explicitly): next-auth's optional `nodemailer` peer range is older than the `nodemailer` version ShareTab pins. Keep `.npmrc` when copying the project, or `npm install` stops with an `ERESOLVE` error.

### Start the dev server

The easiest way is the all-in-one script — it starts an embedded PostgreSQL instance (PostgreSQL 18; Docker and CI use PostgreSQL 16) and the Next.js dev server together:

```bash
cp .env.example .env   # its DATABASE_URL already points at the embedded database
npm run dev:full
```

Or if you have your own PostgreSQL running, copy `.env.example` to `.env`, set `DATABASE_URL`, then create the schema and start the server:

```bash
npx prisma db push
npm run dev
```

### Seed demo data

```bash
npm run db:seed
```

This creates three **test data** accounts (Alice, Bob and Charlie).
Seeding does not enable email/password, Magic Link, Google, or OIDC sign-in.
BillOK accounts must be activated by email confirmation and a verified Passkey.
For isolated signed WebAuthn test fixtures see `e2e/seed-mobile-auth-journey.ts`
and the self-hosted `BillOK CI` workflow.

## Running Tests

### Unit tests

```bash
npm test
```

Runs over 1,100 fast Vitest tests (under 10 seconds). Tests sit next to the code they cover (`src/**/*.test.ts`, plus `docker/**/*.test.mjs` for the Docker build scripts): money and split math, balance computation, rate limiting, verified Passkey-only sign-in, guest sessions, and the admin, auth, balances, expenses, guest, groups, and receipts routers.

### E2E tests

```bash
npx playwright install chromium   # once, to download the browser (add --with-deps on Linux for its system libraries)
npm run dev:full   # in one terminal
BASE_URL=http://localhost:3000 npx playwright test   # in another
```

Tip: set `REGISTER_RATE_LIMIT_MAX=9999`, and `GUEST_RATE_LIMIT_MAX=9999` in `.env` to lift the per-email and per-IP limits during test runs (the global guest caps and the fixed guest limits still apply). Every local request counts against one IP, because Next.js adds an `x-forwarded-for` header to local requests.

The active `BillOK CI` is `.github/workflows/billok-ci.yml`. Its Mobile Chromium
job creates an isolated disposable PostgreSQL database, a loopback TLS SMTP
mailbox, and real P-256/WebAuthn test credentials. The SMTP mailbox is used
only for email confirmation and Passkey recovery, **never for login**.
The historical `.github/workflows/test.yml` is an inherited workflow;
its broader retirement belongs to Issue #1 section 8.2.

### Linting

```bash
npm run lint
```

### Formatting

```bash
npm run format         # auto-fix formatting
npm run format:check   # check only (what CI runs)
```

### Type checking

```bash
npx tsc --noEmit
```

TypeScript runs in strict mode with extra checks, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` (see `tsconfig.json`), and ESLint fails on any warning (`--max-warnings 0`).

### Translations

```bash
npm run lint:i18n   # every locale has exactly the keys English has
```

CI runs it too; run it locally whenever you add or change UI text. See [CONTRIBUTING-TRANSLATIONS.md](CONTRIBUTING-TRANSLATIONS.md).

## Making Changes

### Prisma schema changes

After editing `prisma/schema.prisma`:

```bash
npx prisma db push      # apply to dev DB
npx prisma generate     # regenerate the client
```

**Breaking schema changes** (enum conversions, column type changes, data migrations) can't be handled by `prisma db push` alone. For these, add an idempotent `.sql` file in `prisma/migrations/`. The Docker entrypoint runs all `*.sql` files in that directory before `prisma db push`, so they execute automatically on container startup. Name the file descriptively (e.g., `guest_split_status_enum.sql`) and make it safe to re-run. It must also do nothing on an empty database, because a fresh install runs it before any tables exist.

Database objects that Prisma's schema can't express (for example the unique index on `lower(email)`) go in `prisma/after-push/`, which the entrypoint runs **after** `prisma db push`. These must be idempotent too. An error in either directory stops the container from starting, so for anything optional, log a warning (`RAISE WARNING`) instead of raising an error. CI's `docker-fresh-install.yml` workflow boots the image on an empty volume to check both directories.

### Adding a tRPC route

Routers live in `src/server/trpc/routers/`. Add your procedure there and wire it into `src/server/trpc/router.ts`.

## Pull Request Guidelines

- **One concern per PR** — bug fixes, features, and refactors should be separate PRs.
- **Describe what and why** — the PR description should explain the motivation, not just restate the diff.
- **Add tests** — new logic should have unit tests where possible; new user flows should have e2e coverage.
- **Pass CI** — the required `BillOK CI` on the self-hosted runner runs Vitest, Code quality/types, Coverage regression, Mobile Chromium and mobile PWA tests; check the full five-job result. Run the first six locally before opening a PR. If you change `docker/`, the entrypoint, `prisma/` SQL, or dependencies, also run `npm run test:docker` (the Docker Fresh Install check; `DOCKER_HOST=ssh://user@host` works if you have no local Docker).
- **Document upgrade steps** — if a change needs anything from operators on upgrade (a manual command, a new required variable, a behavior they must know about), add it under **Upgrading** in the README, since build releases only list commit titles.
- **Conventional commits** — use prefixes like `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` in commit messages.

## Project Structure

```
src/
  app/           # Next.js App Router pages
  components/    # React components (organized by domain)
  server/        # tRPC routers, Prisma client, auth, AI providers
  lib/           # Shared utilities (money, splits, etc.)
prisma/
  schema.prisma  # Database schema
docker/          # Dockerfile + docker-compose
```

See [CLAUDE.md](CLAUDE.md) for a full architecture reference.

## Questions?

Open a [GitHub Discussion](https://github.com/sw-carlos-cristobal/sharetab/discussions) or file an issue.
