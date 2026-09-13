# Operations Guide

## Processes

| Process | Command | Notes |
|---|---|---|
| Web app | `npm run build && npm run start` (dev: `npm run dev`) | Stateless; scale horizontally. |
| Worker | `npm run worker` | Scheduler + durable job runner. Run ≥1 instance; claiming is safe with several (`FOR UPDATE SKIP LOCKED`, dedupe keys). |
| Local DB (dev only) | `npm run db:local` | Embedded PostgreSQL 18 in `data/pg`. Never use in production. |

## Scheduled work (worker)

| Job | Default cadence | Quota impact |
|---|---|---|
| `sync.queue` per connection | every 120 min, widened automatically when quota is tight | 1 request per organization (+ pagination, + 1/day organization refresh) |
| `sync.published` per connection | every 24 h (first run backfills 90 days, then 35 days) | 1 request per 100 sent posts per organization |
| `alerts.evaluate` | every 15 min and after each queue sync | none |
| `recommendations.generate` | after each published sync | none (AI calls only if `ANTHROPIC_API_KEY` is set) |
| `report.weekly` per brand | Monday 08:00 brand timezone (configurable per brand) for the previous Mon–Sun week | none |

Quota protection: before every Buffer request the worker checks the latest `RateLimit` header state and refuses to spend the reserved share (`BUFFER_RESERVE_FRACTION_15MIN=0.4`, `_DAILY=0.5`, `_30DAY=0.4`). Refused runs are recorded as `skipped` sync runs with code `quota_reserved` and retried later. **These keys are shared with the existing publishing automations — lower the fractions only deliberately.**

## Health & freshness

- Settings → System: worker heartbeats (`worker_heartbeats`), recent sync runs, quota state per connection.
- Alerts `sync_stale` (account/connection) fire when data is older than the staleness window (default 6 h); `connection_failing` after 3 consecutive failures or immediately for rejected keys.
- Logs are structured JSON on stdout with secret redaction. Ship them to your log platform; alert on `level=error` with `component=worker`.

Useful SQL:

```sql
-- Last successful sync per connection and kind
select c.label, r.kind, max(r.finished_at) from sync_runs r join connections c on c.id = r.connection_id
where r.status in ('succeeded','partial') group by 1,2 order by 1,2;
-- Jobs stuck or dead
select kind, status, attempts, last_error, run_at from jobs where status in ('dead','failed') order by updated_at desc limit 50;
```

## Manual actions

- Sync immediately: `npm run sync:now` (or `-- --connection <id>`, `-- --queue-only`). Respects quota reserves.
- Regenerate a weekly report: Brand → Reports → Regenerate (creates a new version; history kept).
- Weekly reports for all due brands: `npm run reports:run`.

## Credential rotation

1. Generate a new API key in Buffer (Settings → API).
2. BrandPulse → Settings → Connections → Rotate key. The new key must belong to the same Buffer account; it is validated before replacing the old ciphertext.
3. Revoke the old key in Buffer.

### Key-encryption key (KEK) rotation

1. Generate a new 32-byte key; set `BRANDPULSE_KEK_PREVIOUS="<oldVersion>:<oldBase64>"`, the new key in `BRANDPULSE_KEK_FILE`/`BRANDPULSE_KEK` and increment `BRANDPULSE_KEK_VERSION`.
2. Deploy web + worker. Credentials are re-encrypted opportunistically on use; to finish immediately run a one-off `reencryptAllCredentials` (see `src/server/connections/service.ts`).
3. Remove `BRANDPULSE_KEK_PREVIOUS` after all rows report the new key version: `select credential_key_version, count(*) from connections group by 1;`

## Backup & restore

The database holds everything except the KEK. **Back up the KEK separately** (secret manager); a database backup without the KEK cannot decrypt credentials — by design, and credentials can always be re-entered.

Backup (managed PostgreSQL: enable automated daily snapshots + point-in-time recovery, ≥14 days retention). Logical backup:

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > brandpulse-$(date +%F).dump
```

Restore into an empty database:

```bash
createdb brandpulse_restore
pg_restore --no-owner --dbname "postgres://…/brandpulse_restore" brandpulse-YYYY-MM-DD.dump
DATABASE_URL=postgres://…/brandpulse_restore npm run db:migrate   # no-op if already current
```

Then point `DATABASE_URL` to the restored database, start the worker, and verify: sign in, Settings → System shows recent heartbeats, `npm run sync:now -- --queue-only` succeeds. Test a restore quarterly.

Local development backup: stop `npm run db:local`, copy `data/pg/` and `data/pg-local.json`.

## Incident playbooks

| Symptom | Likely cause | Action |
|---|---|---|
| All accounts of a connection show **Unknown / Stale** | worker down, Buffer outage or quota reserve reached | Check Settings → System and last sync error. `quota_reserved` → wait (data age is shown). Buffer 5xx → retries automatic. |
| `connection_failing` critical, "Buffer rejected this connection's API key" | key revoked/rotated in Buffer | Rotate key in Settings → Connections. |
| `publish_failed` "lost authorization" | the social channel must be reconnected inside Buffer | Reconnect channel in Buffer (BrandPulse cannot and does not modify Buffer). |
| Weekly report marked **Preliminary** | metrics not refreshed yet (Buffer refreshes daily) | Regenerate later; history keeps both versions. |
| Report job `dead` | repeated generation failure | Inspect `jobs.last_error`; fix; `npm run reports:run`. The scheduled slot is reused, never duplicated. |
