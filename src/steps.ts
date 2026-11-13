/**
 * The classification pipeline as independently retryable, durable steps.
 *
 * Every step re-reads D1 and skips work that is already recorded there, so a
 * step can be retried, a Workflow instance can be re-created (reprocess,
 * stale recovery, 3-day Workflow retention) and a duplicate Queue delivery can
 * run, without repeating Gemini, filing, archiving or the notification.
 *
 *   load -> gemini-upload -> gemini-classify -> gemini-cleanup -> plan
 *        -> file -> archive -> notify -> complete
 *
 * Step results are tiny (no PDF bytes, no document metadata); the data lives
 * in D1. Permanent failures are returned (not thrown) from the step so the
 * platform does not retry them; transient errors are thrown and retried.
 */

import {
	type Classification,
	conflictName,
	planFiling,
	reviewFallback,
	validateClassification,
} from "./classification.ts";
import { getJob, type JobRow, updateJob } from "./db.ts";
import { type Dropbox, DropboxApiError } from "./dropbox.ts";
import { type Notifier, renderErrorMail, renderFiledMail } from "./email.ts";
import { classifyWithFallback, deleteFile, type GeminiConfig, uploadPdf } from "./gemini.ts";
import { ClassifierError, describeError, log } from "./util.ts";

/** Subset of the Workflows `step` API used here. */
export interface StepConfigLike {
	retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" };
	timeout?: string | number;
}
export interface StepLike {
	do<T>(name: string, config: StepConfigLike, fn: () => Promise<T>): Promise<T>;
}

export interface PipelineDeps {
	db: D1Database;
	dbx: Dropbox;
	gemini: GeminiConfig;
	notifier: Notifier | null;
	/** Dropbox folder receiving processed originals (Make: `/Applications/IncomingScans/_sorted`). */
	archiveFolder: string;
	now?: () => number;
}

const DEFAULT_STEP: StepConfigLike = { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };
const AI_STEP: StepConfigLike = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes" };
/** Gemini accepts PDFs up to 50 MB. */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

const TERMINAL = new Set(["COMPLETED", "REVIEW_REQUIRED", "FAILED", "DRY_RUN_DONE"]);

interface Failed {
	__failed: { category: string; code: string };
}
const isFailed = (v: unknown): v is Failed => typeof v === "object" && v !== null && "__failed" in v;

/** Thrown inside runPipeline to stop after a permanent failure has been returned by a step. */
class Abort extends Error {
	category: string;
	code: string;
	constructor(category: string, code: string) {
		super(code);
		this.category = category;
		this.code = code;
	}
}

/**
 * Run (or resume) the pipeline of one job generation.
 * Never throws for domain failures: they are recorded as FAILED in D1.
 */
export async function runPipeline(deps: PipelineDeps, step: StepLike, params: { jobId: string; generation: number }): Promise<void> {
	const { jobId } = params;
	const now = () => (deps.now ?? Date.now)();

	const run = async <T>(name: string, cfg: StepConfigLike, fn: () => Promise<T>): Promise<T> => {
		const result = await step.do<T | Failed>(name, cfg, async () => {
			try {
				return await fn();
			} catch (e) {
				if (e instanceof ClassifierError && e.category !== "transient") {
					return { __failed: { category: e.category, code: e.code } };
				}
				throw e; // transient: retried by the platform
			}
		});
		if (isFailed(result)) throw new Abort(result.__failed.category, result.__failed.code);
		return result as T;
	};

	try {
		const loaded = await run("load", DEFAULT_STEP, () => loadStep(deps, jobId, params.generation));
		if (loaded.skip) return;

		if (loaded.needsAi) {
			await run("gemini-upload", DEFAULT_STEP, () => uploadStep(deps, jobId));
			await run("gemini-classify", AI_STEP, () => classifyStep(deps, jobId));
		} else if (loaded.oversize) {
			await run("gemini-classify", AI_STEP, () => classifyStep(deps, jobId));
		}
		await run("gemini-cleanup", DEFAULT_STEP, () => cleanupStep(deps, jobId));
		await run("plan", DEFAULT_STEP, () => planStep(deps, jobId));
		await run("file", DEFAULT_STEP, () => fileStep(deps, jobId));
		await run("archive", DEFAULT_STEP, () => archiveStep(deps, jobId));
		await run("notify", DEFAULT_STEP, () => notifyStep(deps, jobId));
		await run("complete", DEFAULT_STEP, () => completeStep(deps, jobId, now()));
	} catch (e) {
		const { category, code } = e instanceof Abort ? e : describeError(e);
		await step.do("record-failure", DEFAULT_STEP, () => failureStep(deps, jobId, category, code, now()));
		log("error", "job failed", { jobId, category, code });
	}
}

/* ---------------------------------- steps ---------------------------------- */

async function mustGet(deps: PipelineDeps, jobId: string): Promise<JobRow> {
	const job = await getJob(deps.db, jobId);
	if (!job) throw new ClassifierError("permanent", "job_missing");
	return job;
}

async function loadStep(
	deps: PipelineDeps,
	jobId: string,
	generation: number,
): Promise<{ skip: boolean; needsAi: boolean; oversize: boolean }> {
	const job = await mustGet(deps, jobId);
	// Terminal job, or an instance from an older generation: do nothing.
	if (TERMINAL.has(job.status) || generation < job.generation) return { skip: true, needsAi: false, oversize: false };

	if (job.classification_json) {
		await updateJob(deps.db, jobId, { status: job.needs_review ? "REVIEW_REQUIRED" : "CLASSIFIED", last_step: "load" });
		return { skip: false, needsAi: false, oversize: false };
	}

	// The registered version must still exist unchanged.
	const meta = await deps.dbx.getMetadata(job.dropbox_file_id);
	if (!meta || meta[".tag"] !== "file") throw new ClassifierError("permanent", "source_missing");
	if (meta.rev !== job.dropbox_rev) throw new ClassifierError("permanent", "source_changed");
	await updateJob(deps.db, jobId, { status: "PROCESSING", last_step: "load" });
	const oversize = (meta.size ?? 0) > MAX_PDF_BYTES;
	return { skip: false, needsAi: !oversize, oversize };
}

async function uploadStep(deps: PipelineDeps, jobId: string): Promise<{ file: string }> {
	const job = await mustGet(deps, jobId);
	if (job.classification_json) return { file: "skipped" };
	// Reuse a recent upload (Google keeps files 48 h) instead of uploading again.
	if (job.gemini_file) {
		const prev = JSON.parse(job.gemini_file) as { at?: number };
		if (typeof prev.at === "number" && (deps.now ?? Date.now)() - prev.at < 24 * 3600 * 1000) return { file: "reused" };
	}
	let res: Response;
	try {
		res = await deps.dbx.download(`rev:${job.dropbox_rev}`);
	} catch (e) {
		if (e instanceof DropboxApiError) throw new ClassifierError("permanent", "source_missing");
		throw e;
	}
	const uploaded = await uploadPdf(deps.gemini, res, job.size ?? Number(res.headers.get("content-length")), jobId);
	await updateJob(deps.db, jobId, { gemini_file: JSON.stringify({ ...uploaded, at: (deps.now ?? Date.now)() }), last_step: "gemini-upload" });
	return { file: "uploaded" };
}

async function classifyStep(deps: PipelineDeps, jobId: string): Promise<{ model: string }> {
	const job = await mustGet(deps, jobId);
	if (job.classification_json) return { model: job.classification_model ?? "" }; // never re-bill Gemini

	let classification: Classification;
	let model: string;
	if (!job.gemini_file) {
		// Oversized: no AI call, straight to manual review.
		classification = reviewFallback("Fichier trop volumineux pour l'analyse automatique");
		model = "none";
	} else {
		const file = JSON.parse(job.gemini_file) as { name: string; uri: string; mimeType: string };
		const out = await classifyWithFallback(deps.gemini, file);
		model = out.model;
		classification = out.result.kind === "ok" ? out.result.value : reviewFallback("Sortie IA invalide ou inexploitable");
		if (out.result.kind === "invalid") log("warn", "invalid AI output; routed to review", { jobId, reason: out.result.reason });
	}
	await updateJob(deps.db, jobId, {
		classification_json: JSON.stringify(classification),
		classification_model: model,
		status: "CLASSIFIED",
		last_step: "gemini-classify",
	});
	return { model };
}

/** Delete the uploaded Gemini file. Best-effort: Google expires it after 48 h anyway. */
async function cleanupStep(deps: PipelineDeps, jobId: string): Promise<{ deleted: boolean }> {
	const job = await mustGet(deps, jobId);
	if (!job.gemini_file || !job.classification_json) return { deleted: false };
	const file = JSON.parse(job.gemini_file) as { name: string };
	const deleted = await deleteFile(deps.gemini, file.name);
	if (deleted) await updateJob(deps.db, jobId, { gemini_file: null });
	return { deleted };
}

function storedClassification(job: JobRow): Classification {
	const v = validateClassification(JSON.parse(job.classification_json ?? "null"));
	if (!v.ok) throw new ClassifierError("permanent", "stored_classification_invalid");
	return v.value;
}

async function planStep(deps: PipelineDeps, jobId: string): Promise<{ review: boolean }> {
	const job = await mustGet(deps, jobId);
	const plan = planFiling(storedClassification(job), job.processing_date);
	// A plan persisted earlier is kept so retries and replays use identical names.
	await updateJob(deps.db, jobId, {
		dest_folder: job.dest_folder ?? plan.folder,
		dest_name: job.dest_name ?? plan.fileName,
		needs_review: plan.needsReview ? 1 : 0,
		review_reason: plan.reviewReason,
		status: plan.needsReview ? "REVIEW_REQUIRED" : "CLASSIFIED",
		last_step: "plan",
	});
	return { review: plan.needsReview };
}

/** Copy to the planned destination and verify the content hash. Idempotent. */
async function fileStep(deps: PipelineDeps, jobId: string): Promise<{ filed: boolean }> {
	const job = await mustGet(deps, jobId);
	if (job.mode === "dry_run") return { filed: false };
	if (job.dest_path) return { filed: true }; // already verified by an earlier attempt
	if (!job.dest_folder || !job.dest_name) throw new ClassifierError("permanent", "no_plan");

	const matches = (e: { content_hash?: string; size?: number }) =>
		job.content_hash ? e.content_hash === job.content_hash : e.size === job.size;
	const from = job.dropbox_file_id;
	await deps.dbx.ensureFolder(job.dest_folder);

	let name = job.dest_name;
	for (let attempt = 0; attempt < 2; attempt++) {
		const target = `${job.dest_folder}/${name}`;
		const copied = await deps.dbx.copy(from, target);
		if (copied !== "conflict") {
			if (!matches(copied)) throw new ClassifierError("permanent", "copy_hash_mismatch");
			await updateJob(deps.db, jobId, { dest_path: copied.path_display, dest_name: name, last_step: "file" });
			return { filed: true };
		}
		// Name taken: either our own earlier copy whose acknowledgement was lost
		// (identical content = success) or a different document (use a stable alternative name).
		const existing = await deps.dbx.getMetadata(target);
		if (existing && existing[".tag"] === "file" && matches(existing)) {
			await updateJob(deps.db, jobId, { dest_path: existing.path_display, dest_name: name, last_step: "file" });
			return { filed: true };
		}
		name = conflictName(job.dest_name, jobId);
	}
	throw new ClassifierError("permanent", "dest_conflict");
}

/** Move the original to the archive folder, only after the copy is verified. */
async function archiveStep(deps: PipelineDeps, jobId: string): Promise<{ archived: boolean }> {
	const job = await mustGet(deps, jobId);
	if (job.mode === "dry_run" || job.archive_path) return { archived: false };
	if (!job.dest_path) throw new ClassifierError("permanent", "archive_before_verified_copy"); // invariant

	// A move whose acknowledgement was lost leaves the file (same id) in the archive folder.
	const current = await deps.dbx.getMetadata(job.dropbox_file_id);
	if (current && current.path_lower.startsWith(`${deps.archiveFolder.toLowerCase()}/`)) {
		await updateJob(deps.db, jobId, { archive_path: current.path_display, last_step: "archive" });
		return { archived: true };
	}
	await deps.dbx.ensureFolder(deps.archiveFolder);
	let name = job.source_name;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const moved = await deps.dbx.move(job.dropbox_file_id, `${deps.archiveFolder}/${name}`);
			if (moved !== "conflict") {
				await updateJob(deps.db, jobId, { archive_path: moved.path_display, last_step: "archive" });
				return { archived: true };
			}
			name = conflictName(job.source_name, jobId);
		} catch (e) {
			// Source already gone: a previous attempt moved it and the acknowledgement was lost.
			if (e instanceof DropboxApiError && e.summary.startsWith("from_lookup/not_found")) {
				await updateJob(deps.db, jobId, { archive_path: `${deps.archiveFolder}/${name}`, last_step: "archive" });
				return { archived: true };
			}
			throw e;
		}
	}
	throw new ClassifierError("permanent", "archive_conflict");
}

/** E-mail, at-least-once: SENDING is recorded before the send, SENT after. */
async function notifyStep(deps: PipelineDeps, jobId: string): Promise<{ sent: boolean }> {
	const job = await mustGet(deps, jobId);
	if (job.mode === "dry_run" || job.notify_status === "SENT" || job.notify_status === "SKIPPED") return { sent: false };
	if (!deps.notifier) {
		log("warn", "no notifier configured; notification skipped", { jobId });
		await updateJob(deps.db, jobId, { notify_status: "SKIPPED" });
		return { sent: false };
	}
	const classification = storedClassification(job);
	const plan = planFiling(classification, job.processing_date);
	const finalPath = job.dest_path as string;
	const mail = renderFiledMail({
		jobId,
		classification,
		// The persisted plan decides the name actually used.
		plan: { ...plan, fileName: job.dest_name ?? plan.fileName },
		sourceName: job.source_name,
		finalPath,
		finalName: finalPath.slice(finalPath.lastIndexOf("/") + 1),
		generation: job.generation,
	});
	await updateJob(deps.db, jobId, { notify_status: "SENDING", notify_attempts: job.notify_attempts + 1 });
	await deps.notifier.send(mail);
	await updateJob(deps.db, jobId, { notify_status: "SENT", last_step: "notify" });
	return { sent: true };
}

async function completeStep(deps: PipelineDeps, jobId: string, now: number): Promise<{ status: string }> {
	const job = await mustGet(deps, jobId);
	const status = job.mode === "dry_run" ? "DRY_RUN_DONE" : job.needs_review ? "REVIEW_REQUIRED" : "COMPLETED";
	await updateJob(deps.db, jobId, { status, last_step: "complete", completed_at: now, error_category: null, error_code: null }, now);
	return { status };
}

/** Persist FAILED and send one error alert per generation. */
async function failureStep(deps: PipelineDeps, jobId: string, category: string, code: string, now: number): Promise<{ ok: true }> {
	const job = await getJob(deps.db, jobId);
	if (!job) return { ok: true };
	await updateJob(deps.db, jobId, { status: "FAILED", error_category: category, error_code: code, completed_at: now }, now);
	if (deps.notifier && job.mode === "live" && !job.error_notified) {
		try {
			await deps.notifier.send(renderErrorMail(jobId, job.generation, category, code));
			await updateJob(deps.db, jobId, { error_notified: 1 }, now);
		} catch {
			log("warn", "error alert could not be sent", { jobId });
		}
	}
	return { ok: true };
}
