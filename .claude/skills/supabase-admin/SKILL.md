---
name: supabase-admin
description: Manage the self-hosted Midday Supabase project (ref elxfxhiwmilsedxgfvjk) via API/SQL without the Supabase dashboard. Use when adding/listing users, applying schema migrations, inspecting tables/triggers, or debugging auth/login on midday.eudaven.com. Triggers — "add a user", "create user", "run a migration", "apply SQL", "check the trigger", "supabase", "why can't X log in".
---

# Supabase Admin (Midday deployment)

Manage Supabase for the Midday app **without opening the Supabase dashboard**.

## Deployment facts

- **Supabase project ref:** `elxfxhiwmilsedxgfvjk` (`https://elxfxhiwmilsedxgfvjk.supabase.co`)
- **App:** dashboard `https://midday.eudaven.com`, api `https://api.midday.eudaven.com`
- **Hosting:** Coolify (`coolify.eudaven.com`) project **Midday-Stack**, 3 separate apps (api/dashboard/worker) + redis. Deployed repo: `sjpenn/middayGEDS`. Local checkout: `sjpenn/midday`.
- **Auth providers:** Google, Apple, Microsoft, GitHub, email OTP (via Supabase GoTrue).

## Two ways to reach the DB

1. **Hosted Supabase MCP** (preferred when authenticated): tools named `mcp__*supabase*` — `execute_sql`, `list_tables`, `apply_migration`, auth admin, etc. If unauthenticated, tell the user to run `/mcp` → authenticate `claude.ai Supabase`.
2. **psql via Coolify-stored connection string** (always works, no dashboard):
   ```bash
   TOK="<coolify api token>"; APP="yrjw88kzhbd001gbtdlbihjj"   # midday-dashboard
   DBURL="$(curl -sS -H "Authorization: Bearer $TOK" \
     https://coolify.eudaven.com/api/v1/applications/$APP/envs \
     | python3 -c 'import sys,json;[print(e["value"]) for e in json.load(sys.stdin) if e.get("key")=="DATABASE_SESSION_POOLER" and e.get("is_preview")==False]')"
   psql "$DBURL" -c '<sql>'
   ```
   The session pooler (`aws-1-us-east-2.pooler.supabase.com:5432`) is IPv4 and connects as the privileged `postgres` role — fine for DDL on `auth.*` and `public.*`. Never echo the connection string.

## Critical invariant: every auth user needs a public.users row

Midday's `withTeamPermission` middleware ([apps/api/src/trpc/middleware/team-permission.ts](apps/api/src/trpc/middleware/team-permission.ts)) runs on **every** `protectedProcedure` (including `user.me`) and throws `NOT_FOUND "User not found"` if `public.users` has no row for `auth.uid()`. A missing row = login 500s / app unusable for that user.

The `on_auth_user_created` trigger on `auth.users` auto-creates the `public.users` row on signup (see [fix-handle-new-user.sql](fix-handle-new-user.sql)). **Signup through the app is fully automatic — no manual user creation needed.** If login breaks for new users, first check the trigger still exists:
```sql
select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal;
-- expect: on_auth_user_created
```

## Common tasks

**Add a user without the dashboard.** Normal path: the person signs in at midday.eudaven.com with any provider — the trigger creates their row automatically. To provision one manually (e.g. email user, no invite):
- Via Supabase MCP auth admin: create the auth user → trigger fills `public.users`.
- Via Admin API:
  ```bash
  SVC="<SUPABASE_SERVICE_ROLE_KEY from Coolify>"
  curl -sS -X POST "https://elxfxhiwmilsedxgfvjk.supabase.co/auth/v1/admin/users" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
    -d '{"email":"new@user.com","email_confirm":true,"user_metadata":{"full_name":"New User"}}'
  ```
  The trigger then creates the `public.users` row. The user finishes at `/onboarding` (creates their team).

**List users:** `select id, email, full_name, team_id, created_at from public.users order by created_at desc;`

**Reconcile (any auth user missing a public row):** re-run the backfill block in [fix-handle-new-user.sql](fix-handle-new-user.sql), then verify `select (select count(*) from auth.users) = (select count(*) from public.users);`

**Apply a schema migration:** prefer Supabase MCP `apply_migration`, or `psql "$DBURL" -v ON_ERROR_STOP=1 -f <file>.sql`. Midday's base schema lives in `packages/db/src/schema.ts` (drizzle); `packages/db/migrations/` holds only incremental ALTERs. For schema sync use `bunx drizzle-kit push` from `packages/db` (reads `DATABASE_SESSION_POOLER`).

## Safety

- Production DDL is hard to reverse — confirm with the user before mutating, show the SQL first.
- Connection strings / service-role keys are secrets — pull them at runtime, never print or commit them.
- Pin all work to ref `elxfxhiwmilsedxgfvjk`; do not touch other Supabase projects.
