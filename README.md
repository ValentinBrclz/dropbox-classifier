# dropbox-classifier

Cloudflare-native replacement for the Make scenario "Classify scans" (6676287).
A new PDF in the Dropbox inbox is registered in D1, classified by Gemini, copied to its destination folder, the original is moved to `_sorted`, and a notification e-mail is sent. Every stage is a durable, independently retryable Workflow step.

> **Safe by default.** `MODE = "dry_run"` (in `wrangler.toml`) classifies and plans but writes nothing to Dropbox and sends no mail. Only `MODE = "live"` files documents. Nothing here is deployed; cutover needs explicit approval (see [Cutover and rollback](#cutover-and-rollback)).
> Read [`docs/GAP_ANALYSIS_AND_PLAN.md`](docs/GAP_ANALYSIS_AND_PLAN.md) first: it lists open questions (notably the Dropbox namespace, R1).

## Architecture

```text
Dropbox ──webhook (signed) / Cron */30──▶ fetch/scheduled handler
                                             │ 1. list changes (cursor in D1)
                                             │ 2. INSERT OR IGNORE job (file id + rev)   ← job row = outbox entry
                                             │ 3. queue.send(jobId)  → mark SENT only after send resolved
                                             ▼
                               Queue (hint only) ──▶ consumer ──▶ Workflow.create(<job>-g<generation>)
                                    └─ DLQ ──▶ handler returns job to the outbox
                                             ▼
   load → gemini-upload → gemini-classify → gemini-cleanup → plan → file → archive → notify → complete
                                             ▼
                                   D1 jobs (authoritative)
   Cron also reconciles: unsent outbox rows, stale jobs, transient failures
```

* **D1 is authoritative.** Queue (24 h) and Workflow (3 days) retention on the Free plan are irrelevant: every step re-reads D1 and skips what is recorded there.
* **Idempotency.** `UNIQUE(dropbox_file_id, dropbox_rev)`; deterministic Workflow instance id; stored Gemini result (never re-billed); planned destination persisted; copy verified by Dropbox `content_hash`; a lost acknowledgement on copy/move is recognised by metadata; e-mail state `NONE → SENDING → SENT`.
* **Filing** uses Dropbox server-side `copy_v2` + `move_v2` (no bytes through the Worker, no CPU): the destination copy is verified (`content_hash` equals the registered one) **before** the original is moved to `_sorted`.
* **Gemini**: the PDF is streamed Dropbox → Gemini Files API (no base64, no buffering), classified with the verbatim Make prompt/schema, and the Gemini file is deleted right after classification.

### Statuses

| Status | Meaning |
|---|---|
| `DISCOVERED` | registered, waiting for dispatch (outbox `PENDING`) |
| `QUEUED` | queue accepted the message |
| `PROCESSING` | Workflow running, not yet classified |
| `CLASSIFIED` | AI result stored (`classification_json`) |
| `COMPLETED` | filed in `/Courants/CUR/<person>/<year>[/COMPTA]`, original archived, mail sent |
| `REVIEW_REQUIRED` | filed in `/Courants/_SCAN_INBOX` (uncertain person/date/issuer, `DIVERS`, invalid AI output, …), mail `[A VERIFIER]`. Terminal; a human files it |
| `FAILED` | needs attention; original untouched in the inbox. Transient failures are re-queued automatically (max 3, 1 h apart); `permanent`/`auth`/`config` are not |
| `DRY_RUN_DONE` | shadow mode result |

`last_step` records the last finished step; `error_category` is `transient | permanent | auth | config | dispatch`; `error_code` is a short code (never document content).

### Behaviour kept from Make (and the few deliberate changes)

Prompt, schema, models, e-mail template, normalisation (`needsReview`, `shortIssuer`, `safeLabel` 47/60, `comptaDocument`), destination rules, e-mail subject/fields: see `src/classification.ts` and the tests. `BERCLAZ_Valentin` is still filed under `/Courants/CUR/BERCLAZ_Valentin/<year>` (as Make does) pending your decision. Deviations: server-side copy instead of re-upload; Gemini file deleted; folders created; processing date frozen at job creation; characters sanitised; extra review triggers (deadline before document date, document date in the future). `docs/make-reference/` holds the verbatim handover; a test fails if `src/prompt.ts` or `src/schema.ts` drift from it.

## Setup

Prerequisites: Node 22+, a Cloudflare account, a Dropbox app (see below).

1. **Dropbox app: Full Dropbox**, scopes `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`. It must see both the inbox and `/Courants`. An *App folder* app cannot write `/Courants`. Get a refresh token with `epost-to-dropbox/scripts/get-dropbox-refresh-token.mjs`.
   **Verify the inbox path as the API sees it** (e.g. `/Apps/IncomingScans`) and set `DROPBOX_SOURCE` / `ARCHIVE_FOLDER`.
2. **Database: reuse `epost-ledger`.** It is created and owned by the `epost-to-dropbox` repository (which creates `epost_letters`); this Worker adds `jobs` and `folder_state` to the same database. The id is already in `wrangler.toml`. Apply `epost-to-dropbox`'s migrations first, then this repository's (either order works; the file names differ, which is required because wrangler records applied migrations by name):
   ```bash
   npx wrangler d1 migrations apply epost-ledger --remote
   ```
   Never alter `epost_letters` here. **Keep the binding names `STATE` and `JOBS_QUEUE` in `wrangler.toml`** (the code reads `env.STATE` / `env.JOBS_QUEUE`; the dashboard may propose other names, which breaks the build). The KV namespace and Queues already exist in the account (the KV id is in `wrangler.toml`). To recreate them elsewhere:
   ```bash
   npx wrangler kv namespace create STATE
   npx wrangler queues create dropbox-classifier-jobs
   npx wrangler queues create dropbox-classifier-dlq
   ```
3. Secrets (`npx wrangler secret put <NAME>`): `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `GEMINI_API_KEY`. For `MODE = "live"` also `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (a live job without them fails with `no_notifier` before touching Dropbox; a dry run needs none).
4. Review the `[vars]` in `wrangler.toml` (`SMTP_HOST` is Zoho's host for your data-centre region).
5. `npm run deploy` (still `dry_run`), then add the Worker URL under **Webhooks** in the Dropbox app console (the Worker answers the challenge; a missed webhook is covered by the 30-minute Cron).
6. Optional, **Cloudflare AI Gateway**: create a gateway and set `GEMINI_BASE_URL` to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio` (add the secret `AI_GATEWAY_TOKEN` if the gateway requires authentication). Only `generateContent` goes through the gateway; the PDF upload and deletion stay direct to Google (the gateway documentation lists only generation endpoints for Google AI Studio). Switching provider later means changing this base URL and the client in `src/gemini.ts`.

Local: `cp .dev.vars.example .dev.vars`, `npm run migrate:local`, `npm run dev`. Tests: `npm test` (typecheck + 55 tests with real SQL via `node:sqlite`, fake Dropbox/Gemini/Queue/Workflow).

### Configuration

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `MODE` | var | `dry_run` | `live` to modify Dropbox and send mail |
| `LOG_LEVEL` | var | `warn` | `error`, `warn` or `info`. `warn` = failures and anomalies only (successful scans are silent); `info` adds the scan/reconcile summaries. Info lines use `console.info` so Workers Logs records level info |
| `DROPBOX_SOURCE` | var | `/Apps/IncomingScans` | watched folder(s), comma separated, non-recursive |
| `ARCHIVE_FOLDER` | var | `/Apps/IncomingScans/_sorted` | processed originals |
| `NOTIFY_TO` | var | `cur@brclz.ch` | recipient |
| `GEMINI_MODEL_PRIMARY` / `_FALLBACK` | var | `gemini-3.8-flash` / `gemini-3.5-flash-lite` | Make's models (both listed as stable by Google on 2026-11-13) |
| `GEMINI_SERVICE_TIER` | var | `flex` | Make used `flex`; documented for the Interactions API, **verify on `generateContent`** (empty = standard) |
| `GEMINI_TIMEOUT_SECONDS` | var | `600` | per call; flex targets 1–15 min |
| `GEMINI_BASE_URL` | var | empty | Cloudflare AI Gateway URL for `generateContent` (empty = direct to Google) |
| `AI_GATEWAY_TOKEN` | optional secret | — | sent as `cf-aig-authorization` |
| `SMTP_HOST` / `SMTP_PORT` | var | `smtp.zoho.eu` / `465` | implicit TLS (port 25 is blocked on Workers) |
| secrets | secret | — | see Setup |

## Operations runbook

Run SQL with `npx wrangler d1 execute epost-ledger --remote --command "<sql>"`. All times are epoch milliseconds.

```sql
-- What needs attention?
SELECT job_id, status, last_step, error_category, error_code, retry_count, datetime(updated_at/1000,'unixepoch') AS updated
FROM jobs WHERE status = 'FAILED' OR (completed_at IS NULL AND updated_at < (strftime('%s','now') - 3600) * 1000);

-- Documents waiting for a human (filed in _SCAN_INBOX)
SELECT job_id, review_reason, dest_path FROM jobs WHERE status = 'REVIEW_REQUIRED';

-- Everything one job did
SELECT * FROM jobs WHERE job_id = 'j…';
```

**Retry a job safely** (new Workflow generation; completed steps are *not* repeated: stored classification, planned destination, verified copy, archive and mail state are reused):

```sql
UPDATE jobs SET generation = generation + 1, status = 'DISCOVERED', dispatch_state = 'PENDING',
  dispatch_attempts = 0, workflow_instance_id = NULL, error_category = NULL, error_code = NULL,
  error_notified = 0, completed_at = NULL, updated_at = strftime('%s','now') * 1000
WHERE job_id = 'j…' AND status = 'FAILED';
```
The next Cron (≤ 30 min) dispatches it. To re-run the AI as well (only while **nothing was filed**: `dest_path IS NULL`), additionally set `classification_json = NULL, dest_folder = NULL, dest_name = NULL, needs_review = NULL, gemini_file = NULL`.

**Typical failures**

| `error_code` | Meaning / action |
|---|---|
| `source_missing` | file gone or moved before processing (e.g. handled by Make or by hand). Check Dropbox; mark resolved |
| `source_changed` | file replaced after registration; the new revision has its own job |
| `dbx_401`, `dbx_oauth_*`, `dbx_missing_scope` | refresh token/scopes (auth/config): fix the secret, then retry |
| `gemini_*_401/403` | API key (auth) |
| `ai_timeout`, `gemini_*_429/5xx`, `dbx_5xx`, `smtp_*_4xx` | transient: automatic retries, then `FAILED(transient)` → re-queued up to 3 times |
| `dest_conflict`, `copy_hash_mismatch`, `archive_conflict` | permanent: inspect Dropbox, then retry or resolve |
| `queue_send`, `dlq` (`dispatch`) | the queue was unavailable 10 times; retry |

**Mark resolved by hand:** `UPDATE jobs SET status = 'COMPLETED', completed_at = strftime('%s','now') * 1000 WHERE job_id = 'j…';`

`wrangler tail` shows structured logs: job ids and codes only.

## Privacy and security

* Secrets only as Worker secrets; Dropbox access token cached (short-lived) in KV; no admin HTTP endpoint (operations are SQL against D1, so there is no recovery surface to protect).
* Webhook signature (HMAC-SHA256) is verified before any work; unsigned requests get 403.
* Logs contain job ids, counts and short codes. Never file names, paths, person names, PDF content or tokens.
* **Cloudflare stores no PDF**: bytes stream Dropbox → Gemini. D1 stores metadata: source file name and ids, the classification (person, issuer, reference, amount, deadline) and destination paths. `classification_json` is nulled 90 days after completion; paths and names are kept for audit. Decide whether to purge them too.
* **Gemini**: the PDF is uploaded to Google's Files API (stored by Google up to 48 h, no download possible) and deleted by this Worker right after classification (display name = job id). Use a **paid-tier (billing-enabled) key**: Google's terms for the unpaid tier allow using content to improve products. Check current terms. The Developer API gives no region choice, so Swiss/EU-only processing is **not guaranteed**; Cloudflare also executes at the nearest edge location unless Regional Services (Enterprise) is used.
* Data-protection points for counsel (not legal advice, unverified): processing by processors (revFADP Art. 9), cross-border disclosure (Art. 16–17), and the confidentiality duties of a curator.

## Cloudflare Free plan: consumption estimate

Assumption: **30 documents/day** (adjust to yours). 9 Workflow steps per document.

| Resource (Free limit) | Estimate at 30 docs/day | Headroom |
|---|---|---|
| Workflow steps (3,000/day) | ~270 (+ retries) | ≈ 330 docs/day before the limit; ≈ 250 with 25 % retries |
| Queue operations (10,000/day) | ~100–200 | large |
| Worker requests (100,000/day) | ~500 (webhooks, 48 crons, queue, workflow) | large |
| D1 rows written (100,000/day) / read (5 M/day) | ~500 / ~5,000 | large |
| KV writes (1,000/day) | ≤ 6 (token cache) | large |
| Subrequests per invocation (50 external) | ≤ ~10 per step | OK |
| CPU 10 ms per invocation | **not measurable offline** | see below |

* **CPU is the one real risk.** Design choices to stay under 10 ms: no hashing/base64/PDF parsing in Workers, server-side Dropbox copy, streamed upload to Gemini, tiny step results. Measure `cpuTime` in `wrangler tail` during the dry-run phase. If a step exceeds it, **Workers Paid** (30 s default) fixes it without code changes; volume (steps/day) is not the constraint at personal scale.
* Queue and DLQ retention (24 h on Free) do not matter: D1 is the recovery registry.
* Gemini charges are separate (flex tier = 50 % of standard rate).

## Shadow run (in parallel with the current Worker and Make)

The classifier can run next to the live `dropbox-to-make` Worker and the Make scenario, which keep working unchanged.

* **Separate Worker.** It is named `dropbox-classifier` (the current one is `dropbox-to-make`), with its own KV, Queues, Workflow and Dropbox app/webhook. Deploy it by hand from this branch (`npm run deploy`); do **not** merge the pull request while shadowing, because a merge to `main` is what the Workers Builds integration deploys for the current Worker.
* **Read-only on Dropbox.** With `MODE = "dry_run"` it only lists, reads metadata and downloads. It never copies, moves, creates folders, sends mail or alerts, so the Dropbox app only needs `files.metadata.read` and `files.content.read` for now (add the write scopes at cutover), and the `SMTP_*` secrets are not needed.
* **What it does consume:** Gemini calls (the same documents are classified twice, once by Make), Worker/Queue/Workflow/D1 quota, and rows in `jobs`. It reads the shared `epost-ledger` database but never touches `epost_letters`.
* **Race with Make is harmless:** Make moves a file to `_sorted` within moments. The classifier reads the registered revision by `rev:` and the file by id, so it still finds it after the move. A file that is deleted or replaced fails as `source_missing` / `source_changed` in the dry run only.
* **First scan:** it registers every PDF currently in the inbox (by design: those are unprocessed). Its cursor lives in D1 and does not interact with the current Worker's cursor.

Compare with Make using the stored plan:

```sql
SELECT datetime(created_at/1000,'unixepoch') AS at, status, classification_model AS model,
       needs_review, review_reason, dest_folder, dest_name, content_hash, error_code
FROM jobs WHERE mode = 'dry_run' ORDER BY created_at DESC;
```
`content_hash` is the Dropbox hash of the original; Make's filed copy has the same hash, which links each job to Make's result in `/Courants`. Check folder, file name, review decision and the e-mail subject rule per document, and note any difference before cutover. Also watch `wrangler tail` for CPU time per Workflow step.

## Cutover and rollback

**Not executed. Each step needs your approval.** The deployed `dropbox-to-make` Worker and the Make scenario stay untouched until step 3. Tag the repository before merging (`git tag last-make-shim 6e78dad`) so the old shim stays reachable.

*Before cutover (shadow phase, `MODE=dry_run`, Make still live):*
1. Deploy; let it classify real inbox documents for several days (the same files Make processes; the Worker writes nothing).
2. Compare per document: `SELECT source_name, dest_folder, dest_name, review_reason, classification_model FROM jobs WHERE status='DRY_RUN_DONE'` against what Make filed. Resolve every discrepancy.
3. Staging checks: `flex` tier accepted on `generateContent`; a test mail through Zoho SMTP; CPU per step; the real inbox path (R1); the seven incomplete Make executions resolved.

*Cutover:*
1. Stop forwarding to Make: remove the old Worker's Dropbox webhook and cron (do **not** delete its KV cursor; it is the rollback path).
2. Wait until Make has no running/incomplete executions and the inbox only contains unprocessed files.
3. Set `MODE = "live"`, `npm run deploy`, watch `jobs`. Jobs created earlier in dry-run keep `mode = 'dry_run'`; re-register those still in the inbox: `DELETE FROM jobs WHERE status = 'DRY_RUN_DONE'; DELETE FROM folder_state;` then trigger a scan.
4. Keep Make disabled (not deleted) for a few weeks.

*Rollback:*
1. `MODE = "dry_run"`, deploy, and `UPDATE jobs SET mode = 'dry_run' WHERE completed_at IS NULL;` (stops all writes; each job fixes its mode when registered).
2. Find documents copied but not archived: `SELECT job_id, dest_path FROM jobs WHERE dest_path IS NOT NULL AND archive_path IS NULL;` and move those originals to `_sorted` by hand (otherwise Make would file them a second time).
3. Re-enable the old Worker's webhook/cron: its preserved cursor resumes and forwards what is still in the inbox to Make; re-enable the Make scenario.

## Known limitations (stated, not hidden)

* Unverified until staging: Zoho SMTP from Workers, `flex` on `generateContent`, Dropbox `create_folder_v2` creating missing parents (relied upon), the real inbox namespace, CPU per step.
* E-mail HTML is Make's template. Two deliberate differences: the Dropbox link keeps `/` unescaped so it opens the folder (Make's `encodeURL` behaviour on slashes is unverified), and "Nom enregistré" is the name actually saved. A small `Réf.` line is appended so a duplicate can be recognised.
* SMTP is at-least-once. A crash between acceptance and the D1 update can produce a duplicate mail (same Message-ID and job reference).
* A document with a blocked/oversized/invalid AI result is filed in `_SCAN_INBOX`, never guessed into a person folder.
* Documents stuck in the inbox because their Dropbox file was replaced or removed show as `FAILED(source_missing|source_changed)`.
