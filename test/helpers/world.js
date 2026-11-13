// Test world: real SQL (node:sqlite), fake Dropbox/Gemini, fake Queue/Workflow, durable-step emulator.
import { mock } from "node:test";
import { Dropbox } from "../../src/dropbox.ts";
import { dispatchPendingJobs, handleJobMessage, reconcile } from "../../src/outbox.ts";
import { runPipeline } from "../../src/steps.ts";
import { instanceIdFor } from "../../src/util.ts";
import { scanFolders } from "../../src/watcher.ts";
import { makeD1 } from "./d1.js";
import { makeDropbox } from "./dropbox.js";
import { makeGemini } from "./gemini.js";

export const T0 = Date.parse("2026-11-13T10:00:00Z");
export const INBOX = "/Apps/IncomingScans";

export class Crash extends Error {}

/** Emulates Workflows: durable memoised steps, per-step retries, process death on demand. */
export function makeStep(store, { crashAfter } = {}) {
	let dead = false;
	return {
		async do(name, cfg, fn) {
			if (dead) throw new Crash("dead");
			if (store.memo.has(name)) return store.memo.get(name);
			let last;
			for (let i = 0; i <= (cfg?.retries?.limit ?? 0); i++) {
				try {
					const r = await fn();
					if (crashAfter === name) {
						dead = true;
						throw new Crash(name);
					}
					store.memo.set(name, r);
					store.ran.push(name);
					return r;
				} catch (e) {
					if (e instanceof Crash) throw e;
					last = e;
				}
			}
			throw last;
		},
	};
}

export function makeWorld({ mode = "live", notifyFails = 0 } = {}) {
	const w = { now: T0, failSql: null };
	// One clock for code under test (updated_at uses Date.now()).
	mock.method(Date, "now", () => w.now);
	w.db = makeD1({
		beforeRun: (sql) => {
			if (w.failSql && sql.includes(w.failSql.match) && w.failSql.times-- > 0) throw new Error("d1 unavailable");
		},
	});
	w.dropbox = makeDropbox();
	w.gem = makeGemini();
	w.mails = [];
	w.notifyFails = notifyFails;
	w.notifier = {
		send: async (m) => {
			if (w.notifyFails > 0) {
				w.notifyFails--;
				throw new Error("smtp down");
			}
			w.mails.push(m);
		},
	};
	w.mode = mode;
	w.dbx = new Dropbox({
		credentials: { appKey: "k", appSecret: "s", refreshToken: "r" },
		fetchFn: w.dropbox.fetchFn,
		maxRetries: 0,
		maxRetryDelayMs: 1,
	});
	w.deps = {
		db: w.db,
		dbx: w.dbx,
		gemini: { apiKey: "g", primaryModel: "P", fallbackModel: "F", serviceTier: "flex", timeoutMs: 1000, fetchFn: w.gem.fetchFn },
		notifier: w.notifier,
		archiveFolder: `${INBOX}/_sorted`,
		now: () => w.now,
	};
	// Queue + Workflow fakes
	w.queue = { sent: [], failSends: 0, async send(m) {
		if (w.queue.failSends > 0) { w.queue.failSends--; throw new Error("queue down"); }
		w.queue.sent.push(m);
	} };
	w.instances = new Map();
	w.workflow = {
		async create({ id, params }) {
			if (w.instances.has(id)) throw new Error("instance.already_exists");
			w.instances.set(id, { params, status: "queued", store: { memo: new Map(), ran: [] } });
		},
		async get(id) {
			const i = w.instances.get(id);
			if (!i) throw new Error("instance.not_found");
			return { status: async () => ({ status: i.status }) };
		},
	};
	/** Deliver all queued messages to the consumer. */
	w.consume = async () => {
		const msgs = w.queue.sent.splice(0);
		for (const m of msgs) await handleJobMessage(w.db, w.workflow, m);
		return msgs.length;
	};
	/** Run every not-yet-run Workflow instance to completion (or failure). */
	w.runInstances = async (opts = {}) => {
		for (const [id, inst] of w.instances) {
			if (inst.status !== "queued") continue;
			try {
				await runPipeline(w.deps, makeStep(inst.store, opts), inst.params);
				inst.status = "complete";
			} catch (e) {
				if (!(e instanceof Crash)) throw e;
				inst.status = "errored"; // process died; reconciler must notice
			}
		}
	};
	w.reconcile = (at = w.now) => reconcile(w.db, w.queue, w.workflow, at);
	/** scan -> dispatch -> consume -> run: one full pass, like webhook + queue + workflow. */
	w.scan = () => scanFolders({ db: w.db, dbx: w.dbx, folders: [INBOX], mode: w.mode, now: () => w.now });
	w.pump = async (opts) => {
		await w.scan();
		await dispatchPendingJobs(w.db, w.queue, w.now);
		await w.consume();
		await w.runInstances(opts);
	};
	w.job = async (i = 0) => (await w.db.prepare("SELECT * FROM jobs ORDER BY created_at, job_id").all()).results[i];
	w.jobs = async () => (await w.db.prepare("SELECT * FROM jobs ORDER BY created_at, job_id").all()).results;
	w.instanceId = (job) => instanceIdFor(job.job_id, job.generation);
	return w;
}
