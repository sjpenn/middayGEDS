# Deploying Midday on Coolify

## Architecture

```
coolify.eudaven.com
│
├── app.yourdomain.com  →  dashboard  (Next.js, port 3000)
├── api.yourdomain.com  →  api        (Hono/Bun, port 8080)
│                          worker     (Bun jobs, internal)
│                          redis      (internal only)
│
└── External services you must provision:
    ├── Supabase  — Auth + Database  (supabase.com)
    └── Cloudflare R2  — File storage
```

---

## Step 1 — Required external services

### 1a. Supabase (Auth + Database)

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Note down from **Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `anon` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SECRET_KEY`
   - JWT Secret (Settings → Auth → JWT Secret) → `SUPABASE_JWT_SECRET`
   - Project reference ID (in the URL) → `SUPABASE_PROJECT_ID`
3. From **Settings → Database → Connection string**:
   - Transaction mode (port 6543) → `DATABASE_PRIMARY_URL`
   - Session mode (port 5432) → `DATABASE_SESSION_POOLER`

### 1b. Run database migrations

From your local machine (requires `bun` installed):
```bash
cd /path/to/midday
bun install
cd packages/supabase
# Set DATABASE_SESSION_POOLER in your shell, then:
bun run db:migrate
```

### 1c. Cloudflare R2 Storage

1. [Cloudflare dashboard](https://dash.cloudflare.com) → **R2** → **Create bucket** (name: `midday-storage`)
2. **Manage R2 API Tokens** → Create token with read/write on the bucket
3. Note your Account ID (top-right in Cloudflare) → build `R2_ENDPOINT`:
   ```
   https://ACCOUNT_ID.r2.cloudflarestorage.com
   ```

---

## Step 2 — Generate secrets

Run these commands and keep the output:

```bash
# NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
openssl rand -base64 32

# INVOICE_JWT_SECRET
openssl rand -hex 32

# FILE_KEY_SECRET
openssl rand -hex 32

# WEBHOOK_SECRET_KEY
openssl rand -hex 32

# MIDDAY_CACHE_API_SECRET
openssl rand -hex 32

# MIDDAY_ENCRYPTION_KEY  (must be 64 hex chars = 32 bytes)
openssl rand -hex 32

# INTERNAL_API_KEY
openssl rand -hex 32
```

---

## Step 3 — Deploy in Coolify

### 3a. Create a new resource

1. In Coolify (`coolify.eudaven.com`) → **New Resource**
2. Select **Docker Compose**
3. Connect your GitHub repo: `sjpenn/midday`
4. Set **Docker Compose file path**: `docker-compose.coolify.yml`

### 3b. Configure domains in Coolify

Coolify will ask you to configure exposed services. Set:
| Service | Domain |
|---------|--------|
| `dashboard` | `app.yourdomain.com` |
| `api` | `api.yourdomain.com` |

> The `worker` and `redis` services are internal only (no domain needed).

### 3c. Add environment variables

Go to your deployment → **Environment Variables** tab.

Copy `.env.coolify.example`, fill in all values, and paste them in.

**Minimum required to boot:**
```
DASHBOARD_DOMAIN=app.yourdomain.com
API_DOMAIN=api.yourdomain.com
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_JWT_SECRET=
SUPABASE_PROJECT_ID=
DATABASE_PRIMARY_URL=
DATABASE_SESSION_POOLER=
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=
RESEND_API_KEY=
OPENAI_API_KEY=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
INVOICE_JWT_SECRET=
FILE_KEY_SECRET=
WEBHOOK_SECRET_KEY=
MIDDAY_CACHE_API_SECRET=
MIDDAY_ENCRYPTION_KEY=
INTERNAL_API_KEY=
```

### 3d. Deploy

Click **Deploy** in Coolify. The build will take **10–15 minutes** on first run (it compiles the full monorepo inside Docker).

---

## Step 4 — Configure Supabase auth redirect URLs

In **Supabase → Authentication → URL Configuration**:

```
Site URL:
  https://app.yourdomain.com

Redirect URLs (add all):
  https://app.yourdomain.com/**
  https://app.yourdomain.com/api/auth/callback
```

---

## Step 5 — Verify deployment

```bash
# API health check
curl https://api.yourdomain.com/health

# Dashboard
open https://app.yourdomain.com
```

---

## Optional integrations

These can be added later — the app works without them:

| Feature | Required keys |
|---------|--------------|
| Bank sync (US) | `PLAID_CLIENT_ID`, `PLAID_SECRET` |
| Bank sync (EU) | `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY` |
| Bank sync (Teller) | `TELLER_CERT_BASE64`, `TELLER_KEY_BASE64` |
| Stripe billing | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` |
| Receipt scanning | `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/KEY` |
| Background jobs | `TRIGGER_SECRET_KEY` |
| Slack bot | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, etc. |
| Telegram bot | `TELEGRAM_BOT_TOKEN` |

---

## Updating

When `midday-ai/midday` pushes updates:

```bash
cd /Users/sjpenn/DEV-SITES/FASTAPI/midday

# Pull upstream changes
git fetch upstream
git merge upstream/main

# Push to your repo (triggers Coolify auto-deploy if enabled)
git push origin main
```

---

## Troubleshooting

**Build fails: `turbo: command not found`**  
→ The Dockerfiles install turbo via bun. Ensure Docker has internet access during build.

**Dashboard can't reach API**  
→ Check `NEXT_PUBLIC_API_URL` matches your API domain exactly.

**Auth redirect loop**  
→ Verify Supabase redirect URLs include `https://app.yourdomain.com/**`

**Redis connection refused**  
→ Redis is internal only. `REDIS_URL=redis://redis:6379` must stay as-is (uses the Docker service name).

**`Failed to find Server Action` errors**  
→ Ensure `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set and identical in all replicas.
