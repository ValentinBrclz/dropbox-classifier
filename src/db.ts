/**
 * D1 access for the job registry / outbox and folder cursors.
 * All statements are parameterised; every write bumps `updated_at`.
 */

import type { DbxEntry } from "./dropbox.ts";
import { jobIdFor, zurichDate } from "./util.ts";

export type Status =
	| "DISCOVERED"
	| "QUEUED"
	| "PROCESSING"
	| "CLASSIFIED"
	| "COMPLETED"
	| "REVIEW_REQUIRED"
	| "FAILED"
	| "DRY_RUN_DONE";

export interface JobRow {
	job_id: string;
	dropbox_file_id: string;
	dropbox_rev: string;
	source_path: string;
	source_name: string;
	size: number | null;
	content_hash: string | null;
	server_modified: string | null;
	status: Status;
	last_step: string | null;
	mode: "live" | "dry_run";
	generation: number;
	workflow_instance_id: string | null;
	dispatch_state: "PENDING" | "SENT";
	dispatch_attempts: number;
	dispatched_at: number | null;
	processing_date: string;
	classification_json: string | null;
	classification_model: string | null;
	needs_review: number | null;
	review_reason: string | null;
	dest_folder: string | null;
	dest_name: string | null;
	dest_path: string | null;
	archive_path: string | null;
	gemini_file: string | null;
	notify_status: "NONE" | "SENDING" | "SENT" | "SKIPPED";
	notify_attempts: number;
	error_notified: number;
	retry_count: number;
	error_category: string | null;
	error_code: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

/** Columns that {@link updateJob} may set. */
type Patch = Partial<
	Pick<
		JobRow,
		| "status"
		| "last_step"
		| "generation"
		| "workflow_instance_id"
		| "dispatch_state"
		| "dispatch_attempts"
		| "dispatched_at"
		| "classification_json"
		| "classification_model"
		| "needs_review"
		| "review_reason"
		| "dest_folder"
		| "dest_name"
		| "dest_path"
		| "archive_path"
		| "gemini_file"
		| "notify_status"
		| "notify_attempts"
		| "error_notified"
		| "retry_count"
		| "error_category"
		| "error_code"
		| "completed_at"
	>
>;

const PATCH_COLUMNS = new Set([
	"status",
	"last_step",
	"generation",
	"workflow_instance_id",
	"dispatch_state",
	"dispatch_attempts",
	"dispatched_at",
	"classification_json",
	"classification_model",
	"needs_review",
	"review_reason",
	"dest_folder",
	"dest_name",
	"dest_path",
	"archive_path",
	"gemini_file",
	"notify_status",
	"notify_attempts",
	"error_notified",
	"retry_count",
	"error_category",
	"error_code",
	"completed_at",
]);

/**
 * Register Dropbox file versions. Idempotent: the UNIQUE (file id, rev)
 * constraint makes duplicate webhooks, concurrent cron runs and cursor resets
 * no-ops. Each row is also the outbox entry (`dispatch_state = 'PENDING'`),
 * so registration and dispatch intent are one atomic write.
 *
 * @returns Number of newly created jobs.
 */
export async function registerJobs(
	db: D1Database,
	entries: DbxEntry[],
	mode: "live" | "dry_run",
	now: number,
): Promise<number> {
	let created = 0;
	const today = zurichDate(now);
	for (let i = 0; i < entries.length; i += 50) {
		const statements: D1PreparedStatement[] = [];
		for (const entry of entries.slice(i, i + 50)) {
			const jobId = await jobIdFor(entry.id, entry.rev ?? "");
			statements.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO jobs
              (job_id, dropbox_file_id, dropbox_rev, source_path, source_name, size, content_hash,
               server_modified, mode, processing_date, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
					)
					.bind(
						jobId,
						entry.id,
						entry.rev ?? "",
						entry.path_lower,
						entry.name,
						entry.size ?? null,
						entry.content_hash ?? null,
						entry.server_modified ?? null,
						mode,
						today,
						now,
						now,
					),
			);
		}
		if (statements.length === 0) continue;
		const results = await db.batch(statements);
		for (const r of results) created += r.meta.changes ?? 0;
	}
	return created;
}

export async function getJob(db: D1Database, jobId: string): Promise<JobRow | null> {
	return db.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first<JobRow>();
}

/** Update whitelisted columns of a job. */
export async function updateJob(
	db: D1Database,
	jobId: string,
	patch: Patch,
	now = Date.now(),
): Promise<void> {
	const cols = Object.keys(patch).filter((k) => PATCH_COLUMNS.has(k));
	if (cols.length === 0) return;
	const sets = cols.map((c) => `${c} = ?`).join(", ");
	const values = cols.map((c) => (patch as Record<string, unknown>)[c] ?? null);
	await db
		.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE job_id = ?`)
		.bind(...values, now, jobId)
		.run();
}

/** Jobs whose dispatch intent has not been confirmed. */
export async function pendingDispatch(db: D1Database, limit: number): Promise<JobRow[]> {
	const r = await db
		.prepare(
			`SELECT * FROM jobs WHERE dispatch_state = 'PENDING' AND status NOT IN ('FAILED','COMPLETED','REVIEW_REQUIRED','DRY_RUN_DONE')
       ORDER BY created_at LIMIT ?`,
		)
		.bind(limit)
		.all<JobRow>();
	return r.results;
}

/** Record that the queue accepted the message (never before `queue.send` resolved). */
export async function markDispatched(db: D1Database, jobId: string, now: number): Promise<void> {
	await db
		.prepare(
			`UPDATE jobs SET dispatch_state = 'SENT', dispatched_at = ?, updated_at = ?,
         status = CASE WHEN status = 'DISCOVERED' THEN 'QUEUED' ELSE status END
       WHERE job_id = ?`,
		)
		.bind(now, now, jobId)
		.run();
}

/** Open jobs (not terminal) that have not moved for `olderThanMs`. */
export async function staleOpenJobs(db: D1Database, olderThanMs: number, now: number, limit = 20): Promise<JobRow[]> {
	const r = await db
		.prepare(
			`SELECT * FROM jobs WHERE completed_at IS NULL AND status != 'FAILED' AND dispatch_state = 'SENT'
         AND updated_at < ? ORDER BY updated_at LIMIT ?`,
		)
		.bind(now - olderThanMs, limit)
		.all<JobRow>();
	return r.results;
}

/** Transiently failed jobs eligible for automatic re-queue. */
export async function retryableFailures(
	db: D1Database,
	cooldownMs: number,
	maxRetries: number,
	now: number,
	limit = 10,
): Promise<JobRow[]> {
	const r = await db
		.prepare(
			`SELECT * FROM jobs WHERE status = 'FAILED' AND error_category IN ('transient','dispatch')
         AND retry_count < ? AND updated_at < ? ORDER BY updated_at LIMIT ?`,
		)
		.bind(maxRetries, now - cooldownMs, limit)
		.all<JobRow>();
	return r.results;
}

/**
 * Put a job back into the outbox under a new generation (new Workflow
 * instance). Stored results (classification, planned destination, verified
 * copy, notification state) are kept, so completed steps are not repeated.
 */
export async function requeueJob(
	db: D1Database,
	job: JobRow,
	opts: { countRetry: boolean },
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`UPDATE jobs SET generation = generation + 1, status = 'DISCOVERED', dispatch_state = 'PENDING',
         dispatch_attempts = 0, workflow_instance_id = NULL, error_category = NULL, error_code = NULL,
         error_notified = 0, completed_at = NULL, retry_count = retry_count + ?, updated_at = ?
       WHERE job_id = ? AND generation = ?`,
		)
		.bind(opts.countRetry ? 1 : 0, now, job.job_id, job.generation)
		.run();
}

/* ------------------------------ cursors ----------------------------------- */

export async function getCursor(db: D1Database, folder: string): Promise<string | null> {
	const r = await db.prepare("SELECT cursor FROM folder_state WHERE folder = ?").bind(folder).first<{ cursor: string }>();
	return r?.cursor ?? null;
}

/**
 * Advance a folder cursor with compare-and-set. If another run advanced it
 * first the update is skipped; both runs registered their own entries before
 * this call, so nothing is lost (the next run re-reads at worst).
 */
export async function advanceCursor(
	db: D1Database,
	folder: string,
	previous: string | null,
	next: string,
	now: number,
): Promise<void> {
	if (previous === null) {
		await db
			.prepare("INSERT OR IGNORE INTO folder_state (folder, cursor, updated_at) VALUES (?,?,?)")
			.bind(folder, next, now)
			.run();
	} else {
		await db
			.prepare("UPDATE folder_state SET cursor = ?, updated_at = ? WHERE folder = ? AND cursor = ?")
			.bind(next, now, folder, previous)
			.run();
	}
}

/** Unconditional cursor replacement after Dropbox reset the old one. */
export async function replaceCursor(db: D1Database, folder: string, next: string, now: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO folder_state (folder, cursor, updated_at) VALUES (?,?,?)
       ON CONFLICT(folder) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
		)
		.bind(folder, next, now)
		.run();
}
