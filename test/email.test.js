import assert from "node:assert/strict";
import test from "node:test";
import { planFiling } from "../src/classification.ts";
import { buildMessage, renderErrorMail, renderFiledMail, sendSmtp } from "../src/email.ts";
import { GOOD } from "./helpers/gemini.js";

const input = (over = {}, today = "2026-11-13") => {
	const c = { ...GOOD, ...over };
	return { jobId: "jabc", classification: c, plan: planFiling(c, today), sourceName: "scan <1>.pdf", finalPath: "/Courants/CUR/X/2026/a.pdf", finalName: "a.pdf", generation: 0 };
};

test("subject tags follow Make: [A VERIFIER] > [ACTION] > [CLASSE]", () => {
	assert.equal(renderFiledMail(input({ action_required: true })).subject, "[ACTION] SCHAFEITEL Christophe - Convocation audience curatelle");
	assert.match(renderFiledMail(input()).subject, /^\[CLASSE\] /);
	const r = renderFiledMail(input({ person_path: null, action_required: true }));
	assert.equal(r.subject, "[A VERIFIER] _A TRIER - Convocation audience curatelle");
	assert.match(r.html, /Document à vérifier/);
	assert.match(r.html, /Personne concernée non identifiable/);
});

test("html escapes dynamic values and carries the job reference", () => {
	const m = renderFiledMail(input({ file_label: "<b>x</b>" }));
	assert.doesNotMatch(m.html, /<b>x<\/b>/);
	assert.match(m.html, /scan &lt;1&gt;\.pdf/);
	assert.match(m.html, /Réf\. jabc/);
	assert.match(renderFiledMail(input({ document_date_iso: null })).html, /Non déterminée/);
});

test("error mail contains no document data", () => {
	const m = renderErrorMail("jabc", 2, "auth", "dbx_401");
	assert.match(m.subject, /jabc/);
	assert.doesNotMatch(m.html, /pdf/i);
});

test("message is MIME-encoded with a deterministic Message-ID", () => {
	const msg = buildMessage({ from: "a@brclz.ch", to: "cur@brclz.ch" }, renderFiledMail(input({ file_label: "Décompte é" })), new Date("2026-11-13T10:00:00Z"));
	assert.match(msg, /Subject: =\?UTF-8\?B\?/);
	assert.match(msg, /Message-ID: <jabc\.g0\.filed@brclz\.ch>/);
	assert.match(msg, /Content-Transfer-Encoding: base64/);
});

/** Scripted SMTP server over in-memory streams. */
function fakeServer(replies) {
	const sent = [];
	let i = 0;
	let ctl;
	const readable = new ReadableStream({ start(c) { ctl = c; c.enqueue(new TextEncoder().encode(`${replies[i++]}\r\n`)); } });
	const writable = new WritableStream({
		write(chunk) {
			const text = new TextDecoder().decode(chunk);
			sent.push(text);
			if (text.startsWith("QUIT")) return;
			const next = replies[i++];
			if (next) ctl.enqueue(new TextEncoder().encode(`${next}\r\n`));
		},
	});
	return { sent, conn: { readable, writable, close() {} } };
}
const OK = ["220 hi", "250-a\r\n250 b", "334 x", "334 y", "235 ok", "250 f", "250 r", "354 go", "250 queued"];
const cfg = (conn) => ({ host: "h", port: 465, user: "u", password: "p", from: "a@brclz.ch", to: "cur@brclz.ch", connect: async () => conn });

test("SMTP happy path speaks the expected dialogue", async () => {
	const s = fakeServer(OK);
	await sendSmtp(cfg(s.conn), renderErrorMail("jabc", 0, "x", "y"));
	assert.deepEqual(s.sent.slice(0, 5).map((x) => x.trim()), ["EHLO classifier", "AUTH LOGIN", btoa("u"), btoa("p"), "MAIL FROM:<a@brclz.ch>"]);
	assert.match(s.sent.find((x) => x.includes("Subject:")), /\r\n\.\r\n$/);
});

test("SMTP error classes: 535 auth, 5xx permanent, 4xx transient", async () => {
	for (const [code, cat] of [[535, "auth"], [550, "permanent"], [451, "transient"]]) {
		const s = fakeServer(["220 hi", "250 b", "334 x", "334 y", `${code} no`]);
		await assert.rejects(sendSmtp(cfg(s.conn), renderErrorMail("j", 0, "a", "b")), (e) => e.category === cat);
	}
});
