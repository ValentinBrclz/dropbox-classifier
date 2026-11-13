/**
 * Outbox dispatch, Queue consumer, DLQ handler and reconciliation.
 *
 * D1 is authoritative. The Queue is only a delivery hint: if a message is
 * lost (24 h retention, DLQ expiry, crash) the reconciler re-dispatches from
 * D1. Every operation here is safe to repeat.
 */

import {
	getJob,
	type JobRow,
	markDispatched,
	pendingDispatch,
	requeueJob,
	retryableFailures,
	staleOpenJobs,
	updateJob,
} from "./db.ts";
import { instanceIdFor, log } from "./util.ts";

export interface JobMessage {
	jobId: string;
	generation: number;
}

export interface QueueLike {
	send(msg: JobMessage): Promise<void>;
}

export interface WorkflowLike {
	create(opts: { id: string; params: JobMessage }): Promise<unknown>;
	get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

/** Give up on dispatching after this many failed attempts (job -> FAILED, visible). */
export const MAX_DISPATCH_ATTEMPTS = 10;
/** An open job untouched for this long is checked against its Workflow instance. */
export const STALE_MS = 45 * 60 * 1000;
/** Transient failures are re-queued automatically at most this often ... */
export const MAX_AUTO_RETRIES = 3;
/** ... with this cooldown between attempts. */
export const RETRY_COOLDOWN_MS = 60 * 60 * 1000;
/** Classification metadata is purged from D1 after this delay. */
export const PURGE_AFTER_MS = 90 * 24 * 3600 * 1000;

const TERMINAL = new Set(["COMPLETED", "REVIEW_REQUIRED", "FAILED", "DRY_RUN_DONE"]);

/** Send every PENDING outbox row to the queue; confirm in D1 only after `send` resolved. */
export async function dispatchPendingJobs(
	db: D1Database,
	queue: QueueLike,
	now: number,
	limit = 25,
): Promise<number> {
	let sent = 0;
	for (const job of await pendingDispatch(db, limit)) {
		try {
			await queue.send({ jobId: job.job_id, generation: job.generation });
			await markDispatched(db, job.job_id, now);
			sent++;
		} catch {
			// Row stays PENDING (a crash here only causes a duplicate message later).
			const attempts = job.dispatch_attempts + 1;
			log("warn", "queue send failed", { jobId: job.job_id, attempts });
			await updateJob(
				db,
				job.job_id,
				attempts >= MAX_DISPATCH_ATTEMPTS
					? { dispatch_attempts: attempts, status: "FAILED", error_category: "dispatch", error_code: "queue_send", completed_at: now }
					: { dispatch_attempts: attempts },
				now,
			);
		}
	}
	return sent;
}

/**
 * Handle one Queue message: start (or find) the job's Workflow instance.
 * Returns normally = acknowledge; throws = the platform retries / dead-letters.
 */
export async function handleJobMessage(db: D1Database, workflow: WorkflowLike, msg: JobMessage): Promise<void> {
	const job = await getJob(db, msg.jobId);
	if (!job) {
		log("warn", "message for unknown job dropped", { jobId: msg.jobId });
		return;
	}
	// Terminal job, or a message from an older generation: nothing to start.
	if (TERMINAL.has(job.status) || msg.generation < job.generation) return;

	const id = instanceIdFor(job.job_id, job.generation);
	try {
		await workflow.create({ id, params: { jobId: job.job_id, generation: job.generation } });
	} catch (e) {
		// Duplicate delivery or webhook/cron race: the instance already exists.
		// Only confirm it really exists; any other error is retried.
		try {
			await workflow.get(id);
		} catch {
			throw e;
		}
	}
	await updateJob(db, job.job_id, { workflow_instance_id: id, dispatch_state: "SENT" });
}

/** Messages that exhausted queue retries: send them back through the outbox. */
export async function handleDeadLetter(db: D1Database, msg: JobMessage, now: number): Promise<void> {
	const job = await getJob(db, msg.jobId);
	if (!job || TERMINAL.has(job.status)) return;
	const attempts = job.dispatch_attempts + 1;
	log("error", "message dead-lettered; returning job to outbox", { jobId: job.job_id, attempts });
	await updateJob(
		db,
		job.job_id,
		attempts >= MAX_DISPATCH_ATTEMPTS
			? { dispatch_attempts: attempts, status: "FAILED", error_category: "dispatch", error_code: "dlq", completed_at: now }
			: { dispatch_attempts: attempts, dispatch_state: "PENDING", error_category: "dispatch", error_code: "dlq" },
		now,
	);
}

export interface ReconcileSummary {
	dispatched: number;
	staleRequeued: number;
	failuresRequeued: number;
	purged: number;
	openFailures: number;
}

/**
 * Cron-driven recovery pass:
 * 1. dispatch the outbox (covers: crash after registration, expired queue messages, DLQ);
 * 2. re-queue open jobs whose Workflow instance is gone, errored or finished without closing the job;
 * 3. re-queue transient failures (bounded, with cooldown);
 * 4. purge old classification metadata.
 */
export async function reconcile(
	db: D1Database,
	queue: QueueLike,
	workflow: WorkflowLike,
	now: number,
): Promise<ReconcileSummary> {
	const dispatched = await dispatchPendingJobs(db, queue, now);

	let staleRequeued = 0;
	for (const job of await staleOpenJobs(db, STALE_MS, now)) {
		if (await workflowIsAlive(workflow, job)) continue;
		await requeueJob(db, job, { countRetry: false }, now);
		staleRequeued++;
		log("warn", "stale job re-queued", { jobId: job.job_id });
	}

	let failuresRequeued = 0;
	for (const job of await retryableFailures(db, RETRY_COOLDOWN_MS, MAX_AUTO_RETRIES, now)) {
		await requeueJob(db, job, { countRetry: true }, now);
		failuresRequeued++;
	}

	// Newly re-queued rows go out immediately instead of waiting for the next run.
	const dispatchedAgain = staleRequeued + failuresRequeued > 0 ? await dispatchPendingJobs(db, queue, now) : 0;

	let purged = 0;
	const d = new Date(now);
	if (d.getUTCHours() === 3 && d.getUTCMinutes() < 30) {
		const r = await db
			.prepare(
				`UPDATE jobs SET classification_json = NULL WHERE classification_json IS NOT NULL
           AND completed_at IS NOT NULL AND completed_at < ?`,
			)
			.bind(now - PURGE_AFTER_MS)
			.run();
		purged = r.meta.changes ?? 0;
	}

	const open = await db
		.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'FAILED'")
		.first<{ n: number }>();
	const openFailures = open?.n ?? 0;
	if (openFailures > 0) log("error", "jobs in FAILED state need attention", { count: openFailures });

	return { dispatched: dispatched + dispatchedAgain, staleRequeued, failuresRequeued, purged, openFailures };
}

async function workflowIsAlive(workflow: WorkflowLike, job: JobRow): Promise<boolean> {
	if (!job.workflow_instance_id) return false;
	try {
		const inst = await workflow.get(job.workflow_instance_id);
		const { status } = await inst.status();
		return ["queued", "running", "paused", "waiting", "waitingForPause"].includes(status);
	} catch {
		return false; // instance expired (3-day retention) or unknown
	}
}
