# Gap analysis and implementation plan (Phase A)

Scope: replace Make scenario 6676287 ("Classify scans") with a Cloudflare-native pipeline.
Sources reviewed: both repositories at their current `main`, the Make handover (`docs/make-reference/`), and the vendor documentation listed under "Verified / unverified facts".

## 1. Parity checklist (Make → Cloudflare)

| Make module | Behaviour | Replacement | Status |
|---|---|---|---|
| 2 webhook | `new_file` metadata from `dropbox-to-make` | D1 job registration + Queue | implemented |
| 10 Dropbox Get File | download `/Applications/IncomingScans{path_lower}` | streamed `files/download` by `rev:` (see risk R1) | implemented |
| 46 prompt + schema | 13-field French prompt/schema | verbatim copy in `src/prompt.ts` / `src/schema.ts`, equality asserted by tests against `docs/make-reference/` | implemented |
| 55 Gemini upload | Files API | resumable upload streamed from Dropbox; deleted after classification (Make never deleted) | implemented |
| 32 / 68 / 75 | Flash, fallback Flash-Lite on error | same models and prompt, configurable IDs | implemented |
| 40 normalisation | needsReview, shortIssuer, safeLabel, compta | `src/classification.ts`, unit-tested against every rule in handover §6 | implemented |
| 41 destination | folder + file name | `src/classification.ts` | implemented |
| 42 upload (+ no folder creation) | new copy of bytes | server-side `files/copy_v2` + content-hash verification; folders created | implemented (deviation D1) |
| 43 move source | to `/_sorted` | `files/move_v2`, only after verified copy | implemented |
| 58 email | HTML mail on every completion, Zoho SMTP | SMTP over `cloudflare:sockets`, same subject/fields | implemented with Make's exact HTML, **unverified against live Zoho** (Workers can open outbound TCP on 465/587; port 25 is blocked) |
| 79 Break | incomplete execution | D1 `FAILED` + error mail + bounded auto-requeue | implemented |

## 2. Inconsistencies found

1. **Brief vs handover contract.** The brief's example JSON (`type`, `year`, `deadlines[]`) is not what Make uses. The handover's 13-field contract is implemented; the brief's is not.
2. **Brief: "notify if necessary" vs Make: mail after every completion.** Make behaviour is preserved (mail on every completion). A filter is a one-line change if wanted.
3. **Brief: uncertain → `REVIEW_REQUIRED` instead of filed.** Make files uncertain documents into `/Courants/_SCAN_INBOX` and mails `[A VERIFIER]`. Both are honoured: `REVIEW_REQUIRED` is a distinct terminal status, and the file lands in `_SCAN_INBOX` (never in a person folder).
4. **`BERCLAZ_Valentin` is filed under `/Courants/CUR/BERCLAZ_Valentin/<year>`** by Make. Kept as-is. Needs your approval before any change.
5. **Watcher scopes.** The current Dropbox app only has `files.metadata.read` + `files.content.read`. Filing needs `files.content.write` and `files.metadata.write`.
6. **7 incomplete Make executions** exist (handover §1). They are stuck documents that are probably still in the inbox. The classifier will pick them up at first run; check them before cutover.
7. **Existing watcher defects fixed by moving to D1:** KV is eventually consistent (lost cursor updates between concurrent webhook + cron); dedup markers expire after 24 h; `waitUntil` work is killed after ~30 s on large backlogs; cursor and dedup writes are not atomic.

## 3. Risks and decisions needing your input

| # | Risk / question | Handling |
|---|---|---|
| R1 | **Dropbox namespace.** Make reads `/Applications/IncomingScans{path_lower}` but writes `/Courants/...` from its own connection root. The current watcher likely uses an *App folder* app (paths relative to `/Apps/IncomingScans`), which cannot reach `/Courants`. | The classifier needs **one Full-Dropbox app token** that sees both the inbox and `/Courants`. `DROPBOX_SOURCE` and `ARCHIVE_FOLDER` are set in that namespace. **Please confirm the real inbox path as the API sees it** (`/Apps/IncomingScans`? the French UI label "Applications" is not an API path). |
| R2 | `flex` service tier is documented for the Interactions endpoint, not `generateContent`. | `GEMINI_SERVICE_TIER` is a variable. Smoke-test in staging before cutover. |
| R3 | ePost API reference URL returned 404 to my fetch; behaviour is taken from the existing Worker, its tests and README only. | See §5. No claim beyond the calls already used in production. |
| R4 | Zoho SMTP from Workers is untested. | Isolated behind a `Notifier` interface; staging send required. Fallback: Cloudflare `send_email` binding. |
| R5 | Free-plan 10 ms CPU per step is only provable on the real platform. | No bytes are hashed or base64-encoded in Workers; Dropbox copies server-side; PDF is streamed to Gemini. Measure with `wrangler tail` in staging. |
| R6 | Strict exactly-once e-mail is impossible over SMTP. | At-least-once with D1 state, deterministic `Message-ID`, job reference in body. |

Deviations from Make, all behaviour-preserving: **D1** copy/move server-side instead of re-uploading bytes (same result, content-hash verified, no CPU); **D2** Gemini file deleted after use; **D3** folders are created; **D4** processing date frozen at job creation; **D5** filename characters sanitised and `short_issuer` stripped to `[A-Z0-9_]`; **D6** extra review triggers (deadline earlier than document date, document date in the future, schema-valid but out-of-range values).

## 4. Architecture decisions

- **D1 is the authority.** `jobs` is simultaneously the job registry and the transactional outbox (`dispatch_state`): registering the job *is* recording the dispatch intent, so there is no window between the two.
- **Instance ID** = `<job_id>-g<generation>`. A manual reprocess bumps `generation`; a new Workflow instance resumes from D1 state (stored classification, planned destination, notification state), so successful steps are not repeated. Workflow retention (3 days) is irrelevant because every step re-reads D1.
- **Cursor in D1**, advanced with compare-and-set only after every listed PDF is registered. Registration is `INSERT OR IGNORE` on `(dropbox_file_id, dropbox_rev)`, so concurrent webhook/cron runs and cursor resets are harmless.
- **Queue = delivery hint only.** Loss/expiry (24 h) is recovered by the reconciler from D1.
- Hand-written validator instead of Zod (13 flat fields; avoids a dependency and start-up CPU).

## 5. ePost "READ but never filed" risk (Worker 1)

Fact (from README/tests of the existing Worker): fetching `/content` marks a letter READ; unread listing therefore never returns it again. Today's mitigation is an immediate reset to UNREAD; if the process dies between download and reset, or the reset fails, the letter is invisible to the next run.

Implemented: a **durable letter ledger** in the `epost-ledger` D1 database (`epost_letters`, owned by the epost-to-dropbox repository; this Worker shares that database). A row is written *before* the download. The next run first recovers every non-terminal row: `UPLOADED` → archive (no re-download, no re-upload); `DOWNLOADING` → reset to UNREAD and let the normal pipeline retry. Rows still unresolved after 1 h are logged at `error` level. Fail-closed rule: if the ledger write fails, the letter is **not** downloaded (it stays UNREAD).

It also fixes a second defect: after classification moves the original out of the inbox, a failed ePost archive previously led to a **second upload of the same letter** (the "already exists" check only looks at the inbox path). The ledger prevents the re-upload.

Limit (stated, not guaranteed): recovery covers letters this Worker touched. A letter marked READ by anything else (ePost UI, another client) is not rediscoverable through the unread filter, and I could not verify any endpoint to enumerate them.

## 6. Plan

1. B: D1 schema, config, watcher → D1, outbox, Queue consumer, DLQ, Workflow skeleton, reconciler. Make forwarding removed from this Worker (the deployed `dropbox-to-make` Worker stays untouched until cutover).
2. C: Gemini client, validation/normalisation, Dropbox filing, e-mail, step functions.
3. Worker 1 ledger and recovery.
4. D: tests (12 required scenarios), local `wrangler dev` run, `wrangler deploy --dry-run`, shadow mode (`MODE=dry_run`: classify and plan, write nothing to Dropbox, send no mail).
5. E: cutover/rollback runbook. Not executed.
