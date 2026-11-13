/**
 * Notification e-mail: content (Make module 58 rules) and a minimal SMTP
 * client (implicit TLS, AUTH LOGIN) over an injected socket.
 *
 * Delivery is at-least-once: SMTP cannot be made exactly-once. D1 records the
 * state (`notify_status`), the Message-ID is deterministic per job and the job
 * reference is in the body, so a rare duplicate is recognisable.
 */

import { type Classification, dropboxHomeLink, type Plan } from "./classification.ts";
import { ClassifierError } from "./util.ts";

export interface OutgoingMail {
	subject: string;
	html: string;
	/** Deterministic per job and kind, e.g. `<j123.g0.filed@classifier>` without the domain. */
	messageIdLocal: string;
	jobId: string;
}

export interface Notifier {
	send(mail: OutgoingMail): Promise<void>;
}

export const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface FiledMailInput {
	jobId: string;
	classification: Classification;
	plan: Plan;
	sourceName: string;
	/** Saved path (path_display) of the verified copy. */
	finalPath: string;
	finalName: string;
	generation: number;
}

/** Make `ifempty(value; fallback)`: null, undefined and "" fall back. */
const ifEmpty = (v: string | null | undefined, fallback: string): string => (v === null || v === undefined || v === "" ? fallback : v);

const LABEL_TD = "padding:6px 10px 6px 0;color:#555;vertical-align:top";

/**
 * Subject and HTML of Make module 58, reproduced from the scenario's template.
 * Differences, on purpose: the Dropbox link keeps `/` unescaped (so it opens the
 * folder), "Nom enregistré" is the name actually saved (differs from the planned
 * one only after a name conflict), and a small job reference line is appended.
 */
export function renderFiledMail(i: FiledMailInput): OutgoingMail {
	const { classification: c, plan: p } = i;
	const tag = p.needsReview ? "[A VERIFIER]" : c.action_required ? "[ACTION]" : "[CLASSE]";
	const heading = p.needsReview ? "⚠️ Document à vérifier" : c.action_required ? "⚠️ Action requise" : "✓ Document classé";
	const amount = c.amount_chf === null ? "—" : String(c.amount_chf);
	const currency = c.amount_chf === null ? "" : " CHF";
	const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#202124;font-size:14px;line-height:1.55;max-width:680px">
  <h2 style="font-size:20px;margin:0 0 8px">${heading}</h2>
  <p style="font-size:16px;margin:0 0 16px"><strong>${escapeHtml(p.safeLabel)}</strong></p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr><td style="padding:6px 10px 6px 0;color:#555;width:145px;vertical-align:top">Dossier</td><td style="padding:6px 0"><strong>${escapeHtml(p.personPath)}</strong></td></tr>
    <tr><td style="${LABEL_TD}">Date du document</td><td style="padding:6px 0">${ifEmpty(c.document_date_iso, "Non déterminée")}</td></tr>
    <tr><td style="${LABEL_TD}">Expéditeur</td><td style="padding:6px 0">${escapeHtml(ifEmpty(c.issuer, "Non identifié"))}</td></tr>
    <tr><td style="${LABEL_TD}">Type</td><td style="padding:6px 0">${escapeHtml(c.document_type)}</td></tr>
    <tr><td style="${LABEL_TD}">Montant</td><td style="padding:6px 0"><strong>${amount}${currency}</strong></td></tr>
    <tr><td style="${LABEL_TD}">Délai / rendez-vous</td><td style="padding:6px 0"><strong>${ifEmpty(c.deadline_iso, "—")}</strong></td></tr>
    <tr><td style="${LABEL_TD}">Action requise</td><td style="padding:6px 0">${c.action_required ? "Oui" : "Non"}</td></tr>
    <tr><td style="${LABEL_TD}">Référence</td><td style="padding:6px 0">${escapeHtml(ifEmpty(c.document_reference, "—"))}</td></tr>
    <tr><td style="${LABEL_TD}">Vérification</td><td style="padding:6px 0">${p.needsReview ? escapeHtml(p.reviewReason ?? "") : "Aucune"}</td></tr>
  </table>
  <div style="background:#f4f6f8;border:1px solid #e1e5e9;border-radius:6px;padding:12px;margin-top:18px">
    <div style="font-weight:bold;margin-bottom:5px">Chemin complet du PDF enregistré dans Dropbox</div>
    <div style="font-family:Consolas,Monaco,monospace;font-size:12px;overflow-wrap:anywhere;word-break:break-word"><a href="${escapeHtml(dropboxHomeLink(i.finalPath))}">${escapeHtml(i.finalPath)}</a></div>
  </div>
  <p style="font-size:12px;color:#6b7280;margin-top:15px">Fichier source : ${escapeHtml(i.sourceName)}<br>Nom enregistré : ${escapeHtml(i.finalName)}</p>
  <p style="font-size:11px;color:#9ca3af;margin-top:8px">Réf. ${i.jobId}</p>
</div>`;
	return {
		subject: `${tag} ${p.personPath} - ${p.safeLabel}`,
		html,
		messageIdLocal: `${i.jobId}.g${i.generation}.filed`,
		jobId: i.jobId,
	};
}

/** Failure alert: job reference and error code only, no document data. */
export function renderErrorMail(jobId: string, generation: number, category: string, code: string): OutgoingMail {
	return {
		subject: `[ERREUR] Classement en échec - réf. ${jobId}`,
		html: `<div style="font-family:Arial,sans-serif;font-size:14px"><h2>❌ Classement en échec</h2>
<p>Réf. <b>${jobId}</b><br>Catégorie : ${escapeHtml(category)}<br>Code : ${escapeHtml(code)}</p>
<p>Le document original est conservé dans le dossier de réception. Voir le runbook (table <code>jobs</code>).</p></div>`,
		messageIdLocal: `${jobId}.g${generation}.error`,
		jobId,
	};
}

/* ------------------------------- SMTP ------------------------------------- */

export interface SmtpConnection {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): Promise<void> | void;
}

export interface SmtpConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	from: string;
	to: string;
	connect: (host: string, port: number) => Promise<SmtpConnection>;
}

const b64 = (s: string): string => {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
};
const wrap76 = (s: string): string => s.replace(/(.{76})/g, "$1\r\n");
// biome-ignore lint/suspicious/noControlCharactersInRegex: header encoding check
const NON_ASCII = /[^ -~]/;
const encodeHeader = (s: string): string => (NON_ASCII.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s);

/** Build the RFC 5322 message. */
export function buildMessage(cfg: Pick<SmtpConfig, "from" | "to">, mail: OutgoingMail, date = new Date()): string {
	const domain = cfg.from.split("@")[1] ?? "localhost";
	return [
		`From: ${cfg.from}`,
		`To: ${cfg.to}`,
		`Subject: ${encodeHeader(mail.subject)}`,
		`Date: ${date.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${mail.messageIdLocal}@${domain}>`,
		`X-Job-Id: ${mail.jobId}`,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(b64(mail.html)),
	].join("\r\n");
}

/** Line reader over the socket; returns one complete (possibly multi-line) SMTP reply. */
class Reader {
	private buf = "";
	private r: ReadableStreamDefaultReader<Uint8Array>;
	private dec = new TextDecoder();
	constructor(s: ReadableStream<Uint8Array>) {
		this.r = s.getReader();
	}
	private async line(): Promise<string> {
		for (;;) {
			const i = this.buf.indexOf("\r\n");
			if (i >= 0) {
				const l = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 2);
				return l;
			}
			const { value, done } = await this.r.read();
			if (done) throw new ClassifierError("transient", "smtp_closed");
			this.buf += this.dec.decode(value, { stream: true });
		}
	}
	async reply(): Promise<{ code: number; text: string }> {
		let text = "";
		for (;;) {
			const l = await this.line();
			text += `${l}\n`;
			if (l.length >= 4 && l[3] === " ") return { code: Number(l.slice(0, 3)), text };
			if (l.length === 3) return { code: Number(l), text };
		}
	}
}

/**
 * Send one message. 4xx replies are transient, 5xx permanent (535 = auth).
 * Credentials and message content are never logged or put in error text.
 */
export async function sendSmtp(cfg: SmtpConfig, mail: OutgoingMail): Promise<void> {
	let conn: SmtpConnection;
	try {
		conn = await cfg.connect(cfg.host, cfg.port);
	} catch {
		throw new ClassifierError("transient", "smtp_connect");
	}
	const reader = new Reader(conn.readable);
	const writer = conn.writable.getWriter();
	const enc = new TextEncoder();
	const say = (s: string) => writer.write(enc.encode(`${s}\r\n`));
	const expect = async (ok: number[], step: string) => {
		const r = await reader.reply();
		if (!ok.includes(r.code)) {
			const cat = r.code === 535 || r.code === 534 ? "auth" : r.code >= 500 ? "permanent" : "transient";
			throw new ClassifierError(cat, `smtp_${step}_${r.code}`);
		}
	};
	try {
		await expect([220], "greeting");
		await say("EHLO classifier");
		await expect([250], "ehlo");
		await say("AUTH LOGIN");
		await expect([334], "auth");
		await say(btoa(cfg.user));
		await expect([334], "user");
		await say(btoa(cfg.password));
		await expect([235], "pass");
		await say(`MAIL FROM:<${cfg.from}>`);
		await expect([250], "from");
		await say(`RCPT TO:<${cfg.to}>`);
		await expect([250, 251], "rcpt");
		await say("DATA");
		await expect([354], "data");
		await say(`${buildMessage(cfg, mail)}\r\n.`);
		await expect([250], "accepted");
		await say("QUIT").catch(() => undefined);
	} finally {
		try {
			await conn.close();
		} catch {
			// ignore
		}
	}
}
