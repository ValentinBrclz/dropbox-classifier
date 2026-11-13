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

/** Subject and heading rules of Make module 58. */
export function renderFiledMail(i: FiledMailInput): OutgoingMail {
	const { classification: c, plan: p } = i;
	const tag = p.needsReview ? "[A VERIFIER]" : c.action_required ? "[ACTION]" : "[CLASSE]";
	const heading = p.needsReview ? "⚠️ Document à vérifier" : c.action_required ? "⚠️ Action requise" : "✓ Document classé";
	const row = (label: string, value: string) =>
		`<tr><td style="padding:4px 12px 4px 0;color:#555">${label}</td><td style="padding:4px 0"><b>${value}</b></td></tr>`;
	const amount = c.amount_chf === null ? "—" : `CHF ${c.amount_chf.toFixed(2)}`;
	const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
<h2 style="margin:0 0 12px">${heading}</h2>
<table style="border-collapse:collapse">
${row("Titre", escapeHtml(p.safeLabel))}
${row("Dossier", escapeHtml(p.personPath))}
${row("Date du document", escapeHtml(c.document_date_iso ?? "Non déterminée"))}
${row("Émetteur", escapeHtml(c.issuer ?? "Non identifié"))}
${row("Type", escapeHtml(c.document_type))}
${row("Montant", escapeHtml(amount))}
${row("Échéance / rendez-vous", escapeHtml(c.deadline_iso ?? "—"))}
${row("Action requise", c.action_required ? "Oui" : "Non")}
${row("Référence", escapeHtml(c.document_reference ?? "—"))}
${row("Motif de revue", escapeHtml(p.needsReview ? (p.reviewReason ?? "Vérification manuelle requise") : "Aucune"))}
</table>
<p><a href="${escapeHtml(dropboxHomeLink(i.finalPath))}">Ouvrir dans Dropbox</a></p>
<p style="color:#555">Fichier source : ${escapeHtml(i.sourceName)}<br>Fichier final : ${escapeHtml(i.finalName)}</p>
<p style="color:#888;font-size:12px">Réf. ${i.jobId}</p>
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
