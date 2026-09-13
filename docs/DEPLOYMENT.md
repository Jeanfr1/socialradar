# Deployment Plan

BrandPulse is a modular monolith: one Next.js web app + one worker process sharing a PostgreSQL database. No other infrastructure is required.

## Target architecture (recommended)

| Component | Recommendation | Why |
|---|---|---|
| Web | Container on a managed runtime (e.g. Fly.io, Render, Railway, AWS App Runner / ECS Fargate, Google Cloud Run with min instances ≥1) running `npm run start` | Node 22 server with server actions and route handlers. |
| Worker | Same image, separate service, command `npm run worker`, 1–2 instances, **always on** (not scale-to-zero) | Durable jobs, weekly reports must run without traffic. |
| Database | Managed PostgreSQL 15+ (e.g. Neon, Supabase, RDS, Cloud SQL) with PITR backups | Relational model, `SKIP LOCKED` job queue, partial unique indexes. |
| Secrets | Platform secret manager (AWS Secrets Manager / GCP Secret Manager / Doppler / Fly secrets) | Provides `BRANDPULSE_KEK` (or a mounted `BRANDPULSE_KEK_FILE`), `DATABASE_URL`, `ANTHROPIC_API_KEY`. |
| TLS / domain | Platform-managed HTTPS | Set `SECURE_COOKIES=true`. |

> Vercel-style serverless hosting works for the web app only; the worker still needs an always-on process elsewhere.

## Environment

See `.env.example`. Production minimum: `DATABASE_URL`, `BRANDPULSE_KEK` or `BRANDPULSE_KEK_FILE`, `BRANDPULSE_KEK_VERSION`, `APP_BASE_URL`, `SECURE_COOKIES=true`, `NODE_ENV=production`. Optional: `ANTHROPIC_API_KEY`, `BRANDPULSE_AI_MODEL` (default `claude-opus-5`), quota reserve fractions, sync intervals, `LOG_LEVEL`.

The KEK must never be stored in the database, the repository, or the same backup as the database.

## Container

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
```

Worker service: same image, `CMD ["npm","run","worker"]`. (`embedded-postgres` is a dev dependency used only by `npm run db:local`; production images may prune dev dependencies after the build if `tsx` is kept for the worker, or bundle the worker.)

## Release procedure

1. CI: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
2. Run migrations once per release before starting new code: `npm run db:migrate` (migrations are additive; see `drizzle/`).
3. Deploy worker and web (order does not matter; jobs are backward compatible within a release).
4. Smoke test: sign in, Portfolio loads, Settings → System shows a fresh worker heartbeat, `sync:now -- --queue-only` succeeds for one connection.

## First-time production setup

1. Provision PostgreSQL and secrets; deploy.
2. `npm run db:migrate`
3. `BRANDPULSE_OWNER_PASSWORD=… npm run setup:owner -- --email you@agency.com --name "You"` (one-off job).
4. Sign in → Settings → Brands: create brands (timezone default America/Sao_Paulo, report language pt-BR).
5. Settings → Connections → Add Buffer connection (paste key into the server-side form; it is validated, encrypted and never shown again).
6. Map discovered channels to brands; configure cadence and thresholds per account.
7. Wait for the first queue sync (≤ 2 min after mapping; or run `sync:now`). Metrics appear after the first published sync.

## Security checklist

- HTTPS only, `SECURE_COOKIES=true`.
- Database not publicly reachable; TLS to the database.
- KEK in secret manager; access limited to web + worker service identities.
- Log shipping keeps redaction (never log request bodies of the connections form).
- Rotate the Buffer keys that were ever shared outside the secret flow (e.g. pasted into chats or files).
- Enabling any Buffer mutation (publishing/scheduling) requires a separate explicit authorization and a code change: the client rejects mutation documents.

## Scaling notes

- 5 Buffer accounts × ~16 requests/day is tiny; the bottleneck is Buffer quota, not compute.
- Add worker instances only for many brands/reports; sync concurrency per connection is already serialized by dedupe keys.
- Metric observations grow ~ posts × metrics × refreshes (≈ 10 rows/post/day for 35 days). Partition or prune `metric_observations` older than 13 months if needed (reports store their own snapshots).
