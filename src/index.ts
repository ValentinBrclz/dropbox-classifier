/**
 * dropbox-classifier: Dropbox webhook + cron + Queue consumer + Workflow host.
 *
 * - fetch:     verified Dropbox webhook -> register new PDFs in D1 -> dispatch outbox
 * - scheduled: every 30 min: same scan (catches missed webhooks) + reconciliation
 * - queue:     job messages start the Workflow; DLQ messages return to the outbox
 *
 * D1 is the authority; the Queue is a delivery hint (see src/outbox.ts).
 * `MODE` must be "live" to modify Dropbox; any other value is a dry run.
 */

import { buildDropbox, initLogging, settings } from "./deps.ts";
import {
	dispatchPendingJobs,
	handleDeadLetter,
	handleJobMessage,
	type JobMessage,
	type QueueLike,
	reconcile,
	type WorkflowLike,
} from "./outbox.ts";
import { verifySignature } from "./signature.ts";
import { log } from "./util.ts";
import { parseSourceFolders, scanFolders } from "./watcher.ts";

export { ClassifierWorkflow } from "./workflow.ts";

const DLQ_NAME = "dropbox-classifier-dlq";

const queueOf = (env: Env): QueueLike => ({ send: async (m) => {
		await (env.JOBS_QUEUE as Queue<JobMessage>).send(m);
	},
});
const workflowOf = (env: Env): WorkflowLike => env.CLASSIFIER_WORKFLOW as unknown as WorkflowLike;

/** Register new PDFs, then push the outbox to the queue. */
async function scanAndDispatch(env: Env): Promise<void> {
	const s = settings(env);
	const { registered, failedFolders } = await scanFolders({
		db: env.DB,
		dbx: buildDropbox(env),
		folders: parseSourceFolders(s.folders),
		mode: s.mode,
	});
	const dispatched = await dispatchPendingJobs(env.DB, queueOf(env), Date.now());
	log("info", "scan done", { registered, failedFolders, dispatched, mode: s.mode });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		initLogging(env);
		if (request.method === "GET") {
			const challenge = new URL(request.url).searchParams.get("challenge") ?? "";
			return new Response(challenge, {
				headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" },
			});
		}
		if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

		const raw = await request.text();
		const signature = request.headers.get("X-Dropbox-Signature") ?? "";
		if (!signature || !(await verifySignature(raw, signature, env.DROPBOX_APP_SECRET.trim()))) {
			log("warn", "webhook rejected: invalid signature");
			return new Response("invalid signature", { status: 403 });
		}
		// Acknowledge within Dropbox's ~10 s; a failure here is recovered by the cron scan.
		ctx.waitUntil(scanAndDispatch(env).catch(() => log("error", "webhook scan failed")));
		return new Response("ok", { status: 200 });
	},

	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		initLogging(env);
		ctx.waitUntil(
			(async () => {
				await scanAndDispatch(env).catch(() => log("error", "scheduled scan failed"));
				const r = await reconcile(env.DB, queueOf(env), workflowOf(env), Date.now());
				log("info", "reconcile done", { ...r });
			})().catch(() => log("error", "scheduled reconcile failed")),
		);
	},

	async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
		initLogging(env);
		const dead = batch.queue === DLQ_NAME;
		for (const msg of batch.messages) {
			try {
				if (dead) await handleDeadLetter(env.DB, msg.body, Date.now());
				else await handleJobMessage(env.DB, workflowOf(env), msg.body);
				msg.ack();
			} catch {
				// Not acknowledged: retried with backoff, then dead-lettered.
				log("warn", "queue message failed; retrying", { jobId: msg.body.jobId, attempts: msg.attempts });
				msg.retry({ delaySeconds: Math.min(300, 15 * 2 ** (msg.attempts - 1)) });
			}
		}
	},
} satisfies ExportedHandler<Env, JobMessage>;
