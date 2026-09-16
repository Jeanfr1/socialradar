# Deployment Plan — Vercel + Supabase

> **Live deployment:** https://socialradar-xi.vercel.app (Vercel project `socialradar`, Supabase project `yuluwgtlsshhwhsricyy`, region eu-west-1).
> The Supabase pooler certificate chain is not accepted by `pg`'s `verify-full` default, so `DATABASE_URL` ends with `?sslmode=require&uselibpqcompat=true` (encrypted connection, libpq semantics).

BrandPulse is a modular monolith: a Next.js app plus background work (sync, alerts, insights, weekly reports) sharing one PostgreSQL database.

On Vercel there is no long-running process, so the background work runs through **`/api/cron/tick`**, an authenticated endpoint that does exactly what the worker loop does: recovers stuck jobs, schedules everything due, then claims and runs queued jobs within a time budget. The `npm run worker` process stays available for any always-on host; running both is safe (`FOR UPDATE SKIP LOCKED` + dedupe keys).

| Component | Service | Notes |
|---|---|---|
| Web + cron | Vercel | `vercel.json` registers the cron. Function `maxDuration` is 60 s. |
| Database | Supabase PostgreSQL | Use the **Session pooler** connection string (IPv4-friendly, works from serverless). |
| Secrets | Vercel Environment Variables | `BRANDPULSE_KEK` lives here, never in the database or repo. |
| Provider credentials | Encrypted in the database | Added through Settings → Connections (or `npm run connections:import`). |

## 1. Supabase

1. Create a project (choose a region close to your users; note the database password).
2. Project Settings → Database → Connection string → **Session pooler**, e.g.
   `postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres`
3. Append `?sslmode=require`.
4. Apply the schema from your machine:
   ```bash
   DATABASE_URL='postgresql://…pooler.supabase.com:5432/postgres?sslmode=require' npm run db:migrate
   ```

BrandPulse uses plain PostgreSQL only — no Supabase Auth, Storage or PostgREST. Row Level Security is not required because every query goes through the server with membership checks; leaving RLS enabled on these tables without policies would block the app's own service connection, so keep these tables as created by the migrations.

### Moving existing local data (optional)

Keeps the synced history and encrypted connections. Use the **same** `BRANDPULSE_KEK` in production, otherwise stored credentials cannot be decrypted (re-adding the keys in the UI also works).

```bash
PGBIN=node_modules/@embedded-postgres/darwin-x64/native/bin
$PGBIN/pg_dump --data-only --no-owner --disable-triggers \
  --exclude-table=drizzle.'*' "$LOCAL_DATABASE_URL" > brandpulse-data.sql
$PGBIN/psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f brandpulse-data.sql
```

## 2. Vercel

Environment variables (Production):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase session-pooler string with `?sslmode=require` |
| `BRANDPULSE_KEK` | 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) |
| `BRANDPULSE_KEK_VERSION` | `1` |
| `APP_BASE_URL` | `https://<your-domain>` |
| `SECURE_COOKIES` | `true` |
| `CRON_SECRET` | long random string; Vercel Cron sends it as `Authorization: Bearer …` |
| `DB_POOL_MAX` | `3` |
| `ANTHROPIC_API_KEY` | optional; without it report narratives are deterministic |
| `BRANDPULSE_AI_MODEL` | optional, default `claude-opus-5` |

Deploy:

```bash
vercel login                     # or: export VERCEL_TOKEN=…
vercel link
vercel env add DATABASE_URL production   # repeat per variable
vercel --prod
```

Then create the first user (one-off, from your machine, pointing at Supabase):

```bash
DATABASE_URL='…supabase…' BRANDPULSE_OWNER_PASSWORD='a-long-passphrase' \
  npm run setup:owner -- --email you@example.com --name "You"
```

## 3. Cron cadence

`vercel.json` schedules `/api/cron/tick` daily at `30 11 * * *` (UTC), which is after 08:00 local in both America/Sao_Paulo and Europe/Paris, so Monday reports are generated the same day. **Vercel Hobby runs cron jobs once per day**; Pro runs them on the declared schedule. Consequences on Hobby: data refreshes daily and the weekly report appears on the first run after Monday 08:00 (brand timezone) rather than at 08:00 sharp. Options: upgrade to Pro, or trigger the endpoint from any external scheduler:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/tick
```

The endpoint is idempotent, so extra calls are harmless. Each call spends at most a few Buffer API requests and respects the quota reserved for your existing publishing automations.

## 4. Post-deploy verification

1. `GET https://<domain>/api/cron/tick` without the header → **404** (the secret protects it).
2. With the header → JSON listing scheduled and processed jobs.
3. Sign in, open Portfolio, then Settings → System: recent sync runs and quota state are visible.
4. Brand → Reports: the weekly report opens and the PDF/CSV download works.

## Security checklist

- HTTPS only, `SECURE_COOKIES=true`.
- `BRANDPULSE_KEK` only in Vercel env (and your own backup) — never in the repository or the database dump.
- Rotate any Buffer key that was ever shared outside the secure form, then use Settings → Connections → Rotate key.
- Enabling any Buffer mutation (publishing/scheduling) requires a separate, explicit authorization and a code change: the client rejects mutation documents.

## Scaling notes

- 5 Buffer accounts ≈ 16 requests/day; the constraint is Buffer's quota, not compute.
- `metric_observations` grows roughly with posts × metrics × daily refreshes; prune beyond 13 months if needed (reports keep their own snapshots).
- For a heavier workload, run `npm run worker` on an always-on host (Fly.io, Railway, a small VM) and keep the cron as a safety net.
