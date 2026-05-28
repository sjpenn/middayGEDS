# Deploying Midday on Coolify + Supabase Cloud

> Replaces the earlier self-hosted-Supabase guide. The old guide had a fictional
> `bun run db:migrate` step and assumed schema bootstrap happened automatically.
> Neither was true. This version reflects what actually works, end-to-end,
> against a fresh Supabase Cloud project.

## Architecture

```
coolify.eudaven.com                   supabase.com (Cloud)
│                                     │
├── midday.eudaven.com   → dashboard  ├── Postgres (managed)
├── api.midday.eudaven.com → api      ├── GoTrue auth
│                          worker     ├── Storage (S3-compatible)
│                          redis      └── Project: elxfxhiwmilsedxgfvjk
└── (Coolify orchestration)
```

The dashboard and api are independent Coolify applications built from a
Dockerfile in `apps/dashboard/` and `apps/api/`. The worker has no public
domain. Redis is internal to the compose network. Everything else (DB, auth,
storage) is Supabase Cloud — we no longer run our own Supabase stack.

## One-time prerequisites

You need accounts and creds for:

- **Supabase Cloud** project (Free plan is enough to start).
- **Cloudflare R2** OR **Supabase Storage S3** for the `R2_*` env vars (Midday
  uses `bun:S3Client` against any S3-compatible endpoint). Supabase Storage's
  built-in S3 connection is fine and avoids the extra service.
- **GitHub OAuth app** with callback URL pointing at the Supabase Cloud auth
  endpoint, not at your own domain.
- **Resend** (transactional email), **OpenAI**, **Google Generative AI** for
  the email/AI features. App boots without them; those specific features fail
  until set.

You do NOT need: self-hosted Supabase, Trigger.dev, Plaid/GoCardless, Stripe.
Add those later when you actually use the feature.

## Step 1 — Create the Supabase Cloud project

1. supabase.com → new project. Region close to your Coolify server. Save the DB
   password somewhere you can find it; Supabase shows it once. Note your
   project ref — the `xxxxxxxxxxxx` in `https://xxxxxxxxxxxx.supabase.co`.

2. From **Project Settings → API Keys → Legacy anon, service_role API keys**,
   copy both. Midday's deployed code uses HS256 verification; the new
   `sb_publishable_*` / `sb_secret_*` format will not work without code
   changes. Use the legacy JWTs.

3. From **Project Settings → JWT Keys → Legacy JWT Secret**, click Reveal,
   copy. That's `SUPABASE_JWT_SECRET`. The new ES256 JWK is not interchangeable.

4. From **Connect** (top toolbar) → **Direct → Session pooler** (NOT
   Transaction pooler, NOT Direct), copy the URI. **Free plan defaults Direct
   and Transaction pooler to IPv6.** Coolify cannot reach IPv6 hosts unless
   the underlying server has IPv6 routing. The session pooler is IPv4-proxied
   for free. Replace `[YOUR-PASSWORD]` with your DB password and URL-encode any
   `?`, `#`, `@`, `:` characters in the password.

   Use the same URL for both `DATABASE_PRIMARY_URL` and
   `DATABASE_SESSION_POOLER`. Midday's Drizzle setup is happy with session-mode
   pooling.

5. **Auth → URL Configuration**: set Site URL to `https://midday.eudaven.com`,
   add `https://midday.eudaven.com/**` and `https://api.midday.eudaven.com/**`
   to the redirect allow list.

6. **Auth → Sign In / Providers → GitHub**: toggle on. Supabase shows the
   callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`). Put
   that into your GitHub OAuth app at
   github.com/settings/developers → OAuth Apps → your app → Authorization
   callback URL. Generate a fresh Client Secret while you're there
   (you can't re-view the old one). Paste Client ID + Secret back into
   the Supabase GitHub provider modal. Save.

7. **Storage → S3 → New access key**. Name it `midday-r2-shim`. Copy the
   Access key ID and Secret access key (Supabase shows the secret once).
   These become `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. The
   `R2_ENDPOINT` is `https://<project-ref>.storage.supabase.co/storage/v1/s3`.

8. Create a private bucket via SQL Editor (faster than the UI):
   ```sql
   INSERT INTO storage.buckets (id, name, public, file_size_limit)
   VALUES ('midday-vault', 'midday-vault', false, 52428800);
   ```

## Step 2 — Initialize the schema (CRITICAL — this is what the old doc got wrong)

Midday's `migrations/` folder contains only incremental `ALTER` statements; the
base schema lives only in `packages/db/src/schema.ts`. There is no
`bun run db:migrate` script anywhere in the repo. There is no Dockerfile
entrypoint that runs migrations. Schema initialization is entirely manual.

From a local machine with `bun` installed:

```bash
# 1. Pre-create extensions, the private schema, and stub functions that
#    Supabase Cloud doesn't ship by default. Run this in the Supabase
#    Studio SQL editor:
```

```sql
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
  RETURNS SETOF uuid LANGUAGE sql STABLE
  AS $$ SELECT team_id FROM public.users_on_team WHERE user_id = auth.uid() $$;

CREATE OR REPLACE FUNCTION public.extract_product_names(data json)
  RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT COALESCE(
    (SELECT string_agg(value->>'name', ' ')
       FROM json_array_elements(data)
       WHERE json_typeof(value) = 'object'),
    ''
  ) $$;

CREATE OR REPLACE FUNCTION public.generate_inbox_fts(name text, products text)
  RETURNS tsvector LANGUAGE sql IMMUTABLE
  AS $$ SELECT to_tsvector('english',
                            COALESCE(name, '') || ' ' || COALESCE(products, '')) $$;
```

```bash
# 2. Push the Drizzle schema. From the repo root:
cd packages/db
DATABASE_SESSION_POOLER='<your session-pooler URL with password>' \
  bunx drizzle-kit push --config=drizzle.config.ts
```

Drizzle will diff `schema.ts` against the empty `public` schema and create ~49
tables. Two known cosmetic failures (do not block):

- A few indexes specify wrong operator classes (e.g. `text_ops` on a uuid
  column). The tables are fine; the indexes just don't get created. Pure
  performance impact, no correctness issue.
- The `usersInAuth` Drizzle declaration uses `pgTable("auth.users", ...)`
  which creates a dead-weight literal `"auth.users"` table in the public
  schema. The real `auth.users` (in the `auth` schema) is untouched. Index
  creation on the shadow fails with "users_pkey already exists". Ignore.

Verify with:

```sql
SELECT count(*) FROM pg_tables WHERE schemaname='public';  -- should be ~49
SELECT to_regclass('public.users'),
       to_regclass('public.users_on_team'),
       to_regclass('public.teams');                          -- all 3 non-null
```

## Step 3 — Generate Coolify app secrets

```bash
echo NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$(openssl rand -base64 32)
echo INVOICE_JWT_SECRET=$(openssl rand -hex 32)
echo FILE_KEY_SECRET=$(openssl rand -hex 32)
echo WEBHOOK_SECRET_KEY=$(openssl rand -hex 32)
echo MIDDAY_CACHE_API_SECRET=$(openssl rand -hex 32)
echo MIDDAY_ENCRYPTION_KEY=$(openssl rand -hex 32)
echo INTERNAL_API_KEY=$(openssl rand -hex 32)
```

These can be rotated later but only matter to the running app — they are not
exchanged with Supabase or GitHub.

## Step 4 — Create the three Coolify applications

Each as a separate "Public Repository" resource in your Midday project, all
pointed at `https://github.com/<your-fork>/middayGEDS` on the `main` branch:

| App               | Domain                    | Dockerfile               | Port |
|-------------------|---------------------------|--------------------------|------|
| midday-api        | api.midday.eudaven.com    | /apps/api/Dockerfile     | 8080 |
| midday-dashboard  | midday.eudaven.com        | /apps/dashboard/Dockerfile | 3000 |
| midday-worker     | (no public domain)        | /apps/worker/Dockerfile  | 3001 |

Plus a Redis service in the same project (Coolify → New Resource → Redis,
internal only).

Set all env vars in each app's **Environment Variables** tab. The full list is
below. Three notes:

1. Any `NEXT_PUBLIC_*` env var is inlined by Next.js at **build** time, not
   runtime. Coolify auto-marks them buildtime based on the prefix, but verify
   by checking the UI shows them as "Build-time" after creation.
2. The DB password almost certainly has characters that need URL-encoding in
   the connection string (`?` → `%3F`, `#` → `%23`, etc.). Encode before
   pasting.
3. `API_INTERNAL_URL` — the dashboard's server-side tRPC client (`apps/dashboard/src/trpc/server.tsx`) reads this for SSR calls to the api. **In a docker-compose deployment** with all 3 apps in the same compose file, you can use `http://api:8080` (the service name). **In a separate-app Coolify deployment** (3 independent resources), the hostname `api` does NOT resolve — set this to the api's public URL: `https://api.midday.eudaven.com`. Yes, the SSR call now hairpins out through Traefik and back, adding ~10ms. The alternative is figuring out Coolify's internal hostname for that specific app, which depends on Coolify's networking setup and version. The hairpin is safer.

## Step 5 — Deploy

Trigger each app's first deploy from the Coolify UI or via API:

```bash
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/deploy?uuid=<app-uuid>"
```

Build time: 10–15 min per app. Coolify runs 2 in parallel; total ~30 min.

## Step 6 — Verify end-to-end

```bash
curl https://api.midday.eudaven.com/health        # expect 200
open https://midday.eudaven.com                   # expect login page
```

Click "Continue with GitHub". You should be redirected to GitHub, approve,
land back on the dashboard. First login creates the `public.users` row.
Subsequent requests to `trpc/user.me` should return 200 with your user object.

If anything 500s, get the unwrapped Postgres error this way (Drizzle's
wrapper hides the original):

```bash
# Coolify API: get logs
curl -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/applications/<api-uuid>/logs?lines=500" \
  | jq -r .logs | tail -200
```

If the log only shows `Failed query: <sql>` with no underlying cause, the
error came from postgres-js → drizzle-orm and the original `relation does not
exist` / `column does not exist` was eaten by Drizzle's catch block.
Workarounds: connect to the DB directly via `psql` and run the failing query
to see the real error, or temporarily add `console.error(err.cause)` around
the failing call site.

## Step 7 — Rotate the secrets

This setup likely involved you pasting your `SUPABASE_SERVICE_ROLE_KEY` and DB
password into a chat or env file. Now that the deployment is healthy:

1. Supabase → **JWT Keys → Legacy JWT Secret → Rotate** (rotates the secret
   that signs both anon and service_role). Copy the new keys to Coolify env.
2. Supabase → **Database → Reset password**. Update Coolify env with the new
   pooler URLs.
3. Storage → S3 → revoke the access key, generate a new one. Update Coolify.
4. GitHub OAuth app → Generate a new client secret, delete the old. Update
   Supabase Auth → Providers → GitHub.

Redeploy after rotating so containers pick up the new values.

## Updating

When `midday-ai/midday` pushes upstream changes:

```bash
git fetch upstream
git merge upstream/main
git push origin main         # triggers Coolify auto-deploy if enabled
```

If the upstream merge brings schema changes:

```bash
# Re-run drizzle-kit push against your live DB. CAUTION: push will offer to
# DROP any columns that exist in DB but not in schema.ts. Read every prompt.
cd packages/db
DATABASE_SESSION_POOLER='...' bunx drizzle-kit push --config=drizzle.config.ts
```

For non-trivial schema migrations, use `drizzle-kit generate` + apply the
generated SQL manually via Studio. Do not blindly push to production.

## Required environment variables

The complete set is in [.env.coolify.example](./.env.coolify.example). The
minimum to boot is:

```
DASHBOARD_DOMAIN, API_DOMAIN
SUPABASE_URL, SUPABASE_PROJECT_ID
SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_SUPABASE_ID,
  NEXT_PUBLIC_API_URL, NEXT_PUBLIC_DASHBOARD_URL
DATABASE_PRIMARY_URL, DATABASE_SESSION_POOLER
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
REDIS_URL, REDIS_QUEUE_URL
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, INVOICE_JWT_SECRET, FILE_KEY_SECRET,
  WEBHOOK_SECRET_KEY, MIDDAY_CACHE_API_SECRET, MIDDAY_ENCRYPTION_KEY,
  INTERNAL_API_KEY
API_INTERNAL_URL=http://api:8080
ALLOWED_API_ORIGINS=https://midday.eudaven.com,https://api.midday.eudaven.com
NEW_USER_GATE_ENABLED=false
```

## Required-but-not-actually-used environment variables

Midday crashes on container boot if any of these are missing or empty —
ranging from Zod `z.string().min(1)` validators (`packages/banking/src/env.ts`)
to SDK constructors at module top-level (`new Composio({apiKey: …})`,
`new Polar(…)`, etc.) that throw if no API key is provided.

If you're not wiring the actual integration, set the variable to the literal
string `not-configured` (anything ≥1 char). The feature won't work but the
container will boot. **Set ALL of these** — adding them lazily as crashes
surface is exactly the mistake that turns a clean rebuild into an afternoon.

### Banking providers (packages/banking/src/env.ts Zod validators)

```
PLAID_CLIENT_ID=not-configured
PLAID_SECRET=not-configured
PLAID_ENVIRONMENT=sandbox
GOCARDLESS_SECRET_ID=not-configured
GOCARDLESS_SECRET_KEY=not-configured
ENABLEBANKING_APPLICATION_ID=not-configured
ENABLE_BANKING_KEY_CONTENT=not-configured
ENABLEBANKING_REDIRECT_URL=https://api.midday.eudaven.com/integrations/enablebanking/callback
TELLER_CERT_BASE64=not-configured
TELLER_KEY_BASE64=not-configured
LOGO_DEV_TOKEN=not-configured
```

### SDK module-top-level constructors

These crash because the SDK's constructor validates the API key and throws on
import, before any feature is actually used.

```
COMPOSIO_API_KEY=not-configured
POLAR_ACCESS_TOKEN=not-configured
POLAR_WEBHOOK_SECRET=not-configured
POLAR_ENVIRONMENT=sandbox
STRIPE_SECRET_KEY=not-configured
STRIPE_PUBLISHABLE_KEY=not-configured
STRIPE_CONNECT_CLIENT_ID=not-configured
STRIPE_CONNECT_WEBHOOK_SECRET=not-configured
PLAIN_API_KEY=not-configured
TRIGGER_SECRET_KEY=not-configured
MISTRAL_API_KEY=not-configured
EXA_API_KEY=not-configured
COMPANY_ENRICH_API_KEY=not-configured
```

### App-store / messaging integrations (constructors at import time)

```
SLACK_CLIENT_ID=not-configured
SLACK_CLIENT_SECRET=not-configured
SLACK_SIGNING_SECRET=not-configured
SLACK_STATE_SECRET=not-configured
SLACK_ENCRYPTION_KEY=not-configured
SLACK_OAUTH_REDIRECT_URL=https://api.midday.eudaven.com/integrations/slack/callback
TELEGRAM_BOT_TOKEN=not-configured
TELEGRAM_WEBHOOK_SECRET_TOKEN=not-configured
TELEGRAM_BOT_USERNAME=midday_bot
TELEGRAM_API_BASE_URL=https://api.telegram.org
WHATSAPP_PHONE_NUMBER_ID=not-configured
WHATSAPP_BUSINESS_ACCOUNT_ID=not-configured
WHATSAPP_ACCESS_TOKEN=not-configured
WHATSAPP_VERIFY_TOKEN=not-configured
WHATSAPP_APP_SECRET=not-configured
SENDBLUE_API_KEY=not-configured
SENDBLUE_API_SECRET=not-configured
SENDBLUE_FROM_NUMBER=not-configured
GMAIL_CLIENT_ID=not-configured
GMAIL_CLIENT_SECRET=not-configured
OUTLOOK_CLIENT_ID=not-configured
OUTLOOK_CLIENT_SECRET=not-configured
XERO_CLIENT_ID=not-configured
XERO_CLIENT_SECRET=not-configured
QUICKBOOKS_CLIENT_ID=not-configured
QUICKBOOKS_CLIENT_SECRET=not-configured
QUICKBOOKS_ENVIRONMENT=production
FORTNOX_CLIENT_ID=not-configured
FORTNOX_CLIENT_SECRET=not-configured
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://placeholder.cognitiveservices.azure.com
AZURE_DOCUMENT_INTELLIGENCE_KEY=not-configured
OPENPANEL_CLIENT_ID=not-configured
OPENPANEL_SECRET_KEY=not-configured
GOOGLE_MAPS_API_KEY=not-configured
RESEND_AUDIENCE_ID=not-configured
INSIGHTS_ENABLED=false
SENTRY_DSN=
```

`SENTRY_DSN` is the one exception — it can be empty; the Sentry SDK skips
initialization if no DSN.

When you actually wire any of these integrations for real, replace the
`not-configured` with the real value and redeploy.

## Using Midday with Claude Code (MCP)

Midday exposes a full MCP (Model Context Protocol) server at `/mcp` on the
API. Claude Code can use it to read your transactions, invoices, customers,
bank accounts, and more — directly from natural language prompts.

### What's already set up

The repo root `.mcp.json` registers two MCP servers for Claude Code:

| Server | URL | Use when |
|--------|-----|----------|
| `midday` | `https://api.midday.ai/mcp` | Production midday.ai account |
| `midday-local` | `http://localhost:8080/mcp` | Local `bun dev` session |

To use your **self-hosted** Coolify instance instead, edit `.mcp.json`:
```json
{
  "mcpServers": {
    "midday": {
      "type": "http",
      "url": "https://api.yourdomain.com/mcp"
    }
  }
}
```

### Authentication

#### Option A — OAuth (automatic, recommended)
The first time Claude Code calls a `midday` MCP tool it detects the
`WWW-Authenticate` header and opens a browser OAuth flow. You authorize
the Claude Code client on the Midday OAuth screen and Claude Code stores the
token automatically — no manual steps needed.

#### Option B — API key (manual)
1. Log in to your dashboard → **Settings → Developer → API Keys → Create key**
2. Copy the key (shown only once)
3. Export it in your shell profile so it's never committed:
   ```bash
   # ~/.zshrc or ~/.bashrc
   export MIDDAY_API_KEY=mk_live_xxxx
   ```
4. Update `.mcp.json` to pass it as a header:
   ```json
   {
     "mcpServers": {
       "midday": {
         "type": "http",
         "url": "https://api.yourdomain.com/mcp",
         "headers": {
           "Authorization": "Bearer ${MIDDAY_API_KEY}"
         }
       }
     }
   }
   ```

### Available tools once authenticated

| Tool group | What Claude Code can do |
|---|---|
| `transactions` | List, search, categorize |
| `invoices` | Create, list, get details |
| `customers` | List and look up |
| `bank-accounts` | List connected accounts |
| `tracker` | Log and query time entries |
| `reports` | Revenue, profit, burn rate, runway |
| `documents` | Search uploaded documents |
| `inbox` | List inbox items |
| `search` | Full-text search across all data |
| `team` | Get team and member info |
| `tags` | Manage transaction tags |

---

## Troubleshooting

**Container crashes immediately with `❌ Invalid environment variables` and a
list of `Too small: expected string to have >=1 characters` errors.** See
the previous section. Every var in that error list must be a non-empty string.
Empty/missing values fail because of the Zod validators in
`packages/banking/src/env.ts`.

**500 on `/trpc/user.me` after login.** Schema is incomplete. The
team-permission middleware queries `users` joined laterally with
`users_on_team`. Both tables must exist with all columns from `schema.ts`.
Re-run Step 2.

**Build fails with `extract_product_names(json) does not exist`.** You skipped
the stub functions in Step 2. Run the SQL block again.

**Dashboard loads but every page is 500.** Almost always a `NEXT_PUBLIC_*`
var was set as runtime-only, so the Next.js bundle has `undefined` for
`SUPABASE_URL` etc. In Coolify, the env var must be marked Build-time. The
fastest fix is to re-trigger a deploy after confirming the marking.

**Visiting the dashboard root redirects to `http://localhost:3001/login`.**
Two things are wrong: the dashboard reads `NEXT_PUBLIC_URL` (note the var
name — not `NEXT_PUBLIC_DASHBOARD_URL`), and it's a `NEXT_PUBLIC_*` so it's
baked into the bundle at build time. Set:

```
NEXT_PUBLIC_URL=https://midday.eudaven.com
```

Then **rebuild** the dashboard (not just restart) — `NEXT_PUBLIC_*` are
inlined into the JavaScript bundle during `next build` and cannot be changed
at container runtime. Other `NEXT_PUBLIC_*` vars the dashboard reads at
build time:
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ID`,
`NEXT_PUBLIC_DESKTOP_SCHEME`, `NEXT_PUBLIC_GOOGLE_API_KEY`,
`NEXT_PUBLIC_PLAID_ENVIRONMENT`, `NEXT_PUBLIC_SENDBLUE_NUMBER`,
`NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`, `NEXT_PUBLIC_TELLER_APPLICATION_ID`,
`NEXT_PUBLIC_TELLER_ENVIRONMENT`, `NEXT_PUBLIC_WHATSAPP_NUMBER`. Even the
ones you don't use must exist (any string) — Next.js doesn't fail if they're
undefined at build time but Midday's runtime code may.

**Login redirects loop back to login.** Supabase redirect allow list is
missing the dashboard domain, or the cookie domain is wrong because
`MIDDAY_DASHBOARD_URL` doesn't match the actual host.

**Worker logs flood with `Failed query: select … provider_notification_batches`.**
The `provider_notification_batches` table was not created. Re-check the
drizzle-kit push output for skipped statements.

**Direct connection works locally but Coolify can't reach the DB.** You set
`DATABASE_*_URL` to the Direct connection host (`db.<ref>.supabase.co:5432`).
That host is IPv6-only on the Free plan. Switch to the session pooler host
(`aws-X-region.pooler.supabase.com:5432`).
