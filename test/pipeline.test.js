import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { dispatchPendingJobs, handleJobMessage } from "../src/outbox.ts";
import { runPipeline } from "../src/steps.ts";
import { GOOD } from "./helpers/gemini.js";
import { Crash, INBOX, T0, makeStep, makeWorld } from "./helpers/world.js";

const DEST = "/Courants/CUR/SCHAFEITEL Christophe/2026/20261110 - JPX - Convocation audience curatelle.pdf";
const HOUR = 3600_000;
const calls = (w, ep) => w.dropbox.api.state.calls[ep] ?? 0;

test("happy path: classify, copy+verify, archive source, one mail, Gemini file deleted", async () => {
	const w = makeWorld();
	const src = w.dropbox.api.add(`${INBOX}/scan.pdf`, "%PDF-1 original");
	await w.pump();
	const job = await w.job();
	assert.equal(job.status, "COMPLETED");
	assert.equal(job.notify_status, "SENT");
	assert.equal(job.dest_path, DEST);
	const [dest] = w.dropbox.api.at(DEST);
	assert.equal(dest.bytes.toString(), "%PDF-1 original");
	assert.equal(w.dropbox.api.at(`${INBOX}/_sorted/scan.pdf`).length, 1, "original archived");
	assert.equal(w.dropbox.api.at(`${INBOX}/scan.pdf`).length, 0);
	assert.equal(w.mails.length, 1);
	assert.deepEqual(w.gem.deleted, ["/v1beta/files/f1"]);
	// Same prompt, schema, tier and text as Make module 32.
	const req = w.gem.generate[0];
	assert.equal(req.model, "P");
	assert.equal(req.body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
	assert.equal(req.body.serviceTier, "flex");
	assert.equal(req.body.generationConfig.responseMimeType, "application/json");
	assert.ok(src.id);
});

test("order invariant: the source is only moved after the verified copy exists", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/scan.pdf`);
	await w.pump();
	const eps = w.dropbox.api.log.map((l) => l.ep);
	assert.ok(eps.indexOf("/files/copy_v2") < eps.indexOf("/files/move_v2"));
});

test("dry run classifies and plans but writes nothing to Dropbox and sends no mail", async () => {
	const w = makeWorld({ mode: "dry_run" });
	w.dropbox.api.add(`${INBOX}/scan.pdf`);
	await w.pump();
	const job = await w.job();
	assert.equal(job.status, "DRY_RUN_DONE");
	assert.equal(job.dest_folder, "/Courants/CUR/SCHAFEITEL Christophe/2026");
	assert.equal(calls(w, "/files/copy_v2") + calls(w, "/files/move_v2") + calls(w, "/files/create_folder_v2"), 0);
	assert.equal(w.mails.length, 0);
	assert.equal(w.dropbox.api.at(`${INBOX}/scan.pdf`).length, 1);
});

/* ---- required scenarios 1-12 ------------------------------------------------ */

test("1. duplicate Dropbox webhook deliveries register one job", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	await w.scan();
	await w.scan();
	assert.equal((await w.jobs()).length, 1);
});

test("2. concurrent webhook and cron: one job, one workflow, one filed copy", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await Promise.all([w.scan(), w.scan(), w.scan()]);
	await Promise.all([dispatchPendingJobs(w.db, w.queue, w.now), dispatchPendingJobs(w.db, w.queue, w.now)]);
	await w.consume();
	await w.runInstances();
	assert.equal((await w.jobs()).length, 1);
	assert.equal(w.instances.size, 1);
	assert.equal(w.mails.length, 1);
	assert.equal(w.dropbox.api.at(DEST).length, 1);
	assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM folder_state").first()).n, 1);
});

test("3. crash after D1 registration but before queue dispatch: reconciler dispatches", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan(); // registered; process "dies" before dispatch
	assert.equal(w.queue.sent.length, 0);
	assert.equal((await w.job()).dispatch_state, "PENDING");
	w.queue.failSends = 1; // and the first send attempt fails too
	await w.reconcile();
	assert.equal((await w.job()).dispatch_attempts, 1);
	await w.reconcile();
	await w.consume();
	await w.runInstances();
	assert.equal((await w.job()).status, "COMPLETED");
});

test("4. crash after queue send but before D1 confirmation: duplicate message is harmless", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	w.failSql = { match: "dispatch_state = 'SENT'", times: 1 };
	await dispatchPendingJobs(w.db, w.queue, w.now); // send ok, confirmation lost
	assert.equal(w.queue.sent.length, 1);
	assert.equal((await w.job()).dispatch_state, "PENDING");
	await dispatchPendingJobs(w.db, w.queue, w.now); // outbox re-sends
	assert.equal(w.queue.sent.length, 2);
	await w.consume();
	await w.runInstances();
	assert.equal(w.instances.size, 1);
	assert.equal(w.mails.length, 1);
	assert.equal(w.dropbox.api.at(DEST).length, 1);
});

test("5. duplicate queue consumption and a re-created workflow do not file or mail twice", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	const job = await w.job();
	// Late duplicate message + a brand-new instance (Workflow retention expired).
	await handleJobMessage(w.db, w.workflow, { jobId: job.job_id, generation: 0 });
	await runPipeline(w.deps, makeStep({ memo: new Map(), ran: [] }), { jobId: job.job_id, generation: 0 });
	assert.equal(w.mails.length, 1);
	assert.equal(calls(w, "/files/copy_v2"), 1);
	assert.equal(w.gem.generate.length, 1);
	assert.equal((await w.job()).status, "COMPLETED");
});

test("6a. Gemini timeout on the primary: primary retried once, then fallback model", async () => {
	const w = makeWorld();
	w.gem.script = ["timeout", "timeout"];
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.deepEqual(w.gem.generate.map((g) => g.model), ["P", "P", "F"]);
	assert.equal((await w.job()).classification_model, "F");
	assert.equal((await w.job()).status, "COMPLETED");
});

test("6b. invalid JSON: one regeneration, then manual review (never guessed, never dropped)", async () => {
	const w = makeWorld();
	w.gem.script = ["not json", { ...GOOD, document_type: "BOGUS" }];
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal(w.gem.generate.length, 2);
	const job = await w.job();
	assert.equal(job.status, "REVIEW_REQUIRED");
	assert.match(job.dest_path, /^\/Courants\/_SCAN_INBOX\//);
	assert.match(w.mails[0].subject, /^\[A VERIFIER\]/);
});

test("6c. regeneration succeeds: normal filing", async () => {
	const w = makeWorld();
	w.gem.script = ["garbage"];
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal(w.gem.generate.length, 2);
	assert.equal((await w.job()).status, "COMPLETED");
});

test("6d. primary and fallback both down: transient FAILED, original untouched, one alert", async () => {
	const w = makeWorld();
	w.gem.script = Array(40).fill(503);
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	const job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.equal(job.error_category, "transient");
	assert.equal(w.dropbox.api.at(`${INBOX}/a.pdf`).length, 1);
	assert.equal(calls(w, "/files/copy_v2") + calls(w, "/files/move_v2"), 0);
	assert.equal(w.gem.uploads, 1, "PDF uploaded to Gemini once, reused across retries");
	assert.equal(w.mails.length, 1);
	assert.match(w.mails[0].subject, /^\[ERREUR\]/);
});

test("6e. Gemini auth error is not retried and not masked by the fallback", async () => {
	const w = makeWorld();
	w.gem.script = [401, 401, 401, 401];
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal(w.gem.generate.length, 1);
	const job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.equal(job.error_category, "auth");
	assert.equal(job.retry_count, 0);
});

test("7. Dropbox copy succeeds but the acknowledgement is lost: no second copy", async () => {
	const w = makeWorld();
	w.dropbox.api.loseAck("/files/copy_v2");
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal((await w.job()).status, "COMPLETED");
	assert.equal(w.dropbox.api.at(DEST).length, 1);
	assert.equal([...w.dropbox.api.files.values()].filter((f) => f.path.includes("[")).length, 0, "no alternative-name duplicate");
	assert.equal(w.mails.length, 1);
});

test("7b. lost acknowledgement on the source move is recognised as done", async () => {
	const w = makeWorld();
	w.dropbox.api.loseAck("/files/move_v2");
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal((await w.job()).status, "COMPLETED");
	assert.equal(w.dropbox.api.at(`${INBOX}/_sorted/a.pdf`).length, 1);
});

test("8. queue message expiry: reconciler recovers the job from D1", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	await dispatchPendingJobs(w.db, w.queue, w.now);
	w.queue.sent.length = 0; // message expired after 24 h without being consumed
	w.now = T0 + 25 * HOUR;
	const r = await w.reconcile();
	assert.equal(r.staleRequeued, 1);
	assert.equal((await w.job()).generation, 1);
	await w.consume();
	await w.runInstances();
	assert.equal((await w.job()).status, "COMPLETED");
	assert.equal(w.mails.length, 1);
});

test("8b. a workflow instance that is still running is left alone", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	await dispatchPendingJobs(w.db, w.queue, w.now);
	await w.consume();
	w.instances.values().next().value.status = "running";
	w.now = T0 + 2 * HOUR;
	assert.equal((await w.reconcile()).staleRequeued, 0);
});

test("9a. pagination: every page is registered before the cursor advances", async () => {
	const w = makeWorld();
	for (let i = 0; i < 5; i++) w.dropbox.api.add(`${INBOX}/f${i}.pdf`);
	w.dropbox.api.state.pageSize = 2;
	await w.scan();
	assert.equal((await w.jobs()).length, 5);
	w.dropbox.api.add(`${INBOX}/f5.pdf`);
	await w.scan();
	assert.equal((await w.jobs()).length, 6);
});

test("9b. cursor reset: folder re-listed, known versions not duplicated, new file registered", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	w.dropbox.api.add(`${INBOX}/b.pdf`);
	w.dropbox.api.state.resetNext = true;
	await w.scan();
	assert.equal((await w.jobs()).length, 2);
	await w.scan();
	assert.equal((await w.jobs()).length, 2);
});

test("9c. a failing listing keeps the cursor and registers nothing", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	const before = (await w.db.prepare("SELECT cursor FROM folder_state").first()).cursor;
	w.dropbox.api.add(`${INBOX}/b.pdf`);
	w.dropbox.api.fail("/files/list_folder/continue", 500, 5);
	const r = await w.scan();
	assert.equal(r.failedFolders, 1);
	assert.equal((await w.db.prepare("SELECT cursor FROM folder_state").first()).cursor, before);
	w.dropbox.api.clearFailures();
	await w.scan();
	assert.equal((await w.jobs()).length, 2);
});

test("9d. only PDFs directly in the watched folder are registered", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	w.dropbox.api.add(`${INBOX}/note.txt`);
	w.dropbox.api.add(`${INBOX}/_sorted/old.pdf`);
	await w.scan();
	assert.equal((await w.jobs()).length, 1);
});

test("10. unidentified person or uncertain deadline: REVIEW_REQUIRED in _SCAN_INBOX, never a person folder", async () => {
	for (const over of [{ person_path: null, needs_review: true }, { deadline_iso: "2026-10-01", action_required: true }]) {
		const w = makeWorld();
		w.gem.current = { ...GOOD, ...over };
		w.dropbox.api.add(`${INBOX}/a.pdf`);
		await w.pump();
		const job = await w.job();
		assert.equal(job.status, "REVIEW_REQUIRED", JSON.stringify(over));
		assert.match(job.dest_path, /^\/Courants\/_SCAN_INBOX\//);
		assert.equal(w.dropbox.api.at(`${INBOX}/_sorted/a.pdf`).length, 1);
		assert.match(w.mails[0].subject, /^\[A VERIFIER\]/);
	}
});

test("12a. failure mid-pipeline then recovery: Gemini not repeated, one copy, one filed mail", async () => {
	const w = makeWorld();
	w.dropbox.api.fail("/files/copy_v2", 500, 99);
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	let job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.equal(job.last_step, "plan");
	assert.ok(job.classification_json);
	w.dropbox.api.clearFailures();
	w.now = T0 + 2 * HOUR; // past the retry cooldown
	const r = await w.reconcile();
	assert.equal(r.failuresRequeued, 1);
	await w.consume();
	await w.runInstances();
	job = await w.job();
	assert.equal(job.status, "COMPLETED");
	assert.equal(job.retry_count, 1);
	assert.equal(w.gem.generate.length, 1, "no second Gemini call");
	assert.equal(w.gem.uploads, 1);
	assert.equal(w.dropbox.api.at(DEST).length, 1);
	assert.deepEqual(w.mails.map((m) => m.subject.split(" ")[0]), ["[ERREUR]", "[ACTION]".replace("ACTION", "CLASSE")]);
});

test("12b. process dies after the copy but before the step result: replay completes without a second copy", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.scan();
	await dispatchPendingJobs(w.db, w.queue, w.now);
	await w.consume();
	const [id, inst] = [...w.instances][0];
	await assert.rejects(runPipeline(w.deps, makeStep(inst.store, { crashAfter: "file" }), inst.params), Crash);
	assert.equal(w.dropbox.api.at(DEST).length, 1);
	assert.notEqual((await w.job()).status, "FAILED", "a dead process records nothing");
	// Platform restarts the same instance: memoised steps are skipped.
	await runPipeline(w.deps, makeStep(inst.store), inst.params);
	assert.equal(w.dropbox.api.at(DEST).length, 1);
	assert.equal((await w.job()).status, "COMPLETED");
	assert.equal(w.gem.generate.length, 1);
	assert.equal(w.mails.length, 1);
	assert.ok(id);
});

/* ---- additional safety cases ---------------------------------------------------- */

test("source deleted before classification: permanent FAILED, no blind retries, no data loss", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`, "x", "id:gone");
	await w.scan();
	w.dropbox.api.files.delete("id:gone");
	await dispatchPendingJobs(w.db, w.queue, w.now);
	await w.consume();
	await w.runInstances();
	const job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.equal(job.error_code, "source_missing");
	w.now = T0 + 5 * HOUR;
	assert.equal((await w.reconcile()).failuresRequeued, 0);
});

test("a different file already at the destination name: stable alternative name, both kept", async () => {
	const w = makeWorld();
	w.dropbox.api.add(DEST, "%PDF-1 someone else");
	w.dropbox.api.add(`${INBOX}/a.pdf`, "%PDF-1 mine");
	await w.pump();
	const job = await w.job();
	assert.equal(job.status, "COMPLETED");
	assert.match(job.dest_path, / \[[0-9a-f]{6}\]\.pdf$/);
	assert.equal(w.dropbox.api.at(DEST)[0].bytes.toString(), "%PDF-1 someone else");
});

test("same-named file already archived: source gets a stable alternative archive name", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/_sorted/a.pdf`, "%PDF-1 older");
	w.dropbox.api.add(`${INBOX}/a.pdf`, "%PDF-1 newer");
	await w.pump();
	assert.equal((await w.job()).status, "COMPLETED");
	assert.equal(w.dropbox.api.at(`${INBOX}/a.pdf`).length, 0);
	assert.equal([...w.dropbox.api.files.values()].filter((f) => f.path.startsWith(`${INBOX}/_sorted/`)).length, 2);
});

test("notification failure after filing: job FAILED(transient); recovery sends the mail without refiling", async () => {
	const w = makeWorld({ notifyFails: 99 });
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	let job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.ok(job.dest_path && job.archive_path);
	w.notifyFails = 0;
	w.now = T0 + 2 * HOUR;
	await w.reconcile();
	await w.consume();
	await w.runInstances();
	job = await w.job();
	assert.equal(job.status, "COMPLETED");
	assert.equal(job.notify_status, "SENT");
	assert.equal(calls(w, "/files/copy_v2"), 1);
	assert.equal(w.mails.length, 1);
});

test("a new revision of the same file is a new job; an old-revision instance fails closed", async () => {
	const w = makeWorld();
	w.dropbox.api.add(`${INBOX}/a.pdf`, "v1", "id:same");
	await w.scan();
	const f = w.dropbox.api.files.get("id:same");
	f.rev = "rev-new";
	f.bytes = Buffer.from("v2");
	await dispatchPendingJobs(w.db, w.queue, w.now);
	await w.consume();
	await w.runInstances();
	assert.equal((await w.job()).error_code, "source_changed");
	assert.equal(calls(w, "/files/copy_v2"), 0);
});

test("live mode without a notifier fails closed before touching Dropbox", async () => {
	const w = makeWorld();
	w.deps.notifier = null;
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	const job = await w.job();
	assert.equal(job.status, "FAILED");
	assert.equal(job.error_category, "config");
	assert.equal(job.error_code, "no_notifier");
	assert.equal(w.gem.generate.length, 0);
	assert.equal(calls(w, "/files/copy_v2") + calls(w, "/files/move_v2"), 0);
	assert.equal(w.dropbox.api.at(`${INBOX}/a.pdf`).length, 1);
});

test("dry run needs no notifier and no write scope", async () => {
	const w = makeWorld({ mode: "dry_run" });
	w.deps.notifier = null;
	w.dropbox.api.add(`${INBOX}/a.pdf`);
	await w.pump();
	assert.equal((await w.job()).status, "DRY_RUN_DONE");
	const eps = new Set(w.dropbox.api.log.map((l) => l.ep));
	assert.deepEqual([...eps].filter((e) => /copy|move|create_folder|upload/.test(e)), []);
});
