/**
 * Classification contract: validation of the Gemini output, and the exact
 * Make module 40 (normalisation) and 41 (destination) rules.
 *
 * Pure functions, no I/O. Time zone for dates is Europe/Zurich (the caller
 * passes the frozen processing date).
 */

import { DOCUMENT_TYPES, PERSON_PATHS } from "./schema.ts";

/** The 13-field contract (Make module 46). */
export interface Classification {
	person_path: string | null;
	person_full_name: string | null;
	document_date_iso: string | null;
	document_type: string;
	issuer: string | null;
	short_issuer: string;
	file_label: string;
	needs_review: boolean;
	review_reason: string | null;
	action_required: boolean;
	deadline_iso: string | null;
	amount_chf: number | null;
	document_reference: string | null;
}

export type Validation =
	| { ok: true; value: Classification }
	| { ok: false; reason: string };

const KEYS = [
	"person_path",
	"person_full_name",
	"document_date_iso",
	"document_type",
	"issuer",
	"short_issuer",
	"file_label",
	"needs_review",
	"review_reason",
	"action_required",
	"deadline_iso",
	"amount_chf",
	"document_reference",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDate(s: string): boolean {
	const m = ISO_DATE.exec(s);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const dt = new Date(Date.UTC(y, mo - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Validate parsed model output against the 13-field contract. Reasons are
 * field names only (they may be logged and stored); values are never echoed.
 *
 * @param raw - Parsed JSON from the model.
 */
export function validateClassification(raw: unknown): Validation {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "not_an_object" };
	}
	const o = raw as Record<string, unknown>;
	for (const k of KEYS) if (!(k in o)) return { ok: false, reason: `missing:${k}` };

	const nullableString = (k: string) => o[k] === null || typeof o[k] === "string";
	for (const k of ["person_full_name", "issuer", "review_reason", "document_reference"]) {
		if (!nullableString(k)) return { ok: false, reason: `type:${k}` };
	}
	for (const k of ["short_issuer", "file_label"]) {
		if (typeof o[k] !== "string") return { ok: false, reason: `type:${k}` };
	}
	for (const k of ["needs_review", "action_required"]) {
		if (typeof o[k] !== "boolean") return { ok: false, reason: `type:${k}` };
	}
	if (o.person_path !== null && !(typeof o.person_path === "string" && PERSON_PATHS.includes(o.person_path))) {
		return { ok: false, reason: "enum:person_path" };
	}
	if (typeof o.document_type !== "string" || !DOCUMENT_TYPES.includes(o.document_type)) {
		return { ok: false, reason: "enum:document_type" };
	}
	for (const k of ["document_date_iso", "deadline_iso"]) {
		if (o[k] !== null && !(typeof o[k] === "string" && isRealDate(o[k] as string))) {
			return { ok: false, reason: `date:${k}` };
		}
	}
	if (o.amount_chf !== null && !(typeof o.amount_chf === "number" && Number.isFinite(o.amount_chf) && o.amount_chf >= 0)) {
		return { ok: false, reason: "range:amount_chf" };
	}
	return { ok: true, value: o as unknown as Classification };
}

/**
 * Conservative result used when the model output stays invalid after the
 * controlled regeneration: the document is filed in the review inbox, never
 * guessed into a person folder.
 */
export function reviewFallback(reason: string): Classification {
	return {
		person_path: null,
		person_full_name: null,
		document_date_iso: null,
		document_type: "DIVERS",
		issuer: null,
		short_issuer: "INCONNU",
		file_label: "Document a verifier",
		needs_review: true,
		review_reason: reason,
		action_required: false,
		deadline_iso: null,
		amount_chf: null,
		document_reference: null,
	};
}

/** Result of normalisation + destination (Make modules 40 and 41). */
export interface Plan {
	needsReview: boolean;
	reviewReason: string | null;
	datePart: string;
	docYear: string;
	personPath: string;
	shortIssuer: string;
	safeLabel: string;
	comptaDocument: boolean;
	fileName: string;
	folder: string;
}

/** Characters Dropbox/Windows reject in names, plus control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Remove forbidden characters, collapse blanks, trim blanks and dots at the ends. */
export function safeText(s: string): string {
	return s.replace(FORBIDDEN, " ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
}

/** Uppercase, strip accents, keep A-Z 0-9 _, max 10 chars; INCONNU if empty. */
export function normalizeShortIssuer(s: string | null | undefined): string {
	const cleaned = (s ?? "INCONNU")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toUpperCase()
		.replace(/[^A-Z0-9_]/g, "")
		.slice(0, 10);
	return cleaned || "INCONNU";
}

/**
 * Apply the Make normalisation and destination rules.
 *
 * @param c - Validated classification.
 * @param processingDate - Frozen `YYYY-MM-DD` (Europe/Zurich), used when the document has no date.
 */
export function planFiling(c: Classification, processingDate: string): Plan {
	const hasDate = c.document_date_iso !== null;
	const datePart = (c.document_date_iso ?? processingDate).replaceAll("-", "");
	const docYear = (c.document_date_iso ?? processingDate).slice(0, 4);
	const personPath = c.person_path ?? "_A TRIER";

	let needsReview =
		c.needs_review === true ||
		c.person_path === null ||
		c.document_date_iso === null ||
		c.issuer === null ||
		c.document_type === "DIVERS";

	let reviewReason: string | null = null;
	if (needsReview) {
		reviewReason =
			c.person_path === null
				? "Personne concernée non identifiable"
				: c.document_date_iso === null
					? "Date du document inconnue"
					: c.review_reason || "Vérification manuelle requise";
	}

	// Extra conservative triggers (deviation D6): never file as confirmed.
	if (!needsReview) {
		if (c.document_date_iso && c.document_date_iso > processingDate) {
			needsReview = true;
			reviewReason = "Date du document postérieure à la date de traitement";
		} else if (c.deadline_iso && c.document_date_iso && c.deadline_iso < c.document_date_iso) {
			needsReview = true;
			reviewReason = "Échéance antérieure à la date du document";
		}
	}

	const shortIssuer = normalizeShortIssuer(c.short_issuer);
	const maxLabel = hasDate ? 60 : 47;
	const safeLabel = safeText(safeText(c.file_label || "Document").slice(0, maxLabel)) || "Document";

	const comptaDocument =
		c.document_type === "FACTURE" ||
		(c.document_type === "RAPPEL" && c.action_required === true && c.amount_chf !== null);

	const fileName = `${datePart} - ${shortIssuer} - ${safeLabel}${hasDate ? "" : " (check date)"}.pdf`;
	const folder = needsReview
		? "/Courants/_SCAN_INBOX"
		: `/Courants/CUR/${personPath}/${docYear}${comptaDocument ? "/COMPTA" : ""}`;

	return {
		needsReview,
		reviewReason,
		datePart,
		docYear,
		personPath,
		shortIssuer,
		safeLabel,
		comptaDocument,
		fileName,
		folder,
	};
}

/** Deterministic alternative name when the planned name is taken by *different* content. */
export function conflictName(fileName: string, jobId: string): string {
	return fileName.replace(/\.pdf$/i, ` [${jobId.slice(1, 7)}].pdf`);
}

/** Dropbox web link to a saved path (segments URL-encoded). */
export function dropboxHomeLink(pathDisplay: string): string {
	return `https://www.dropbox.com/home${pathDisplay.split("/").map(encodeURIComponent).join("/")}`;
}
