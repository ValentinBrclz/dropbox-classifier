import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conflictName, dropboxHomeLink, normalizeShortIssuer, planFiling, safeText, validateClassification } from "../src/classification.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { RESPONSE_SCHEMA } from "../src/schema.ts";
import { GOOD } from "./helpers/gemini.js";

const ref = (f) => new URL(`../docs/make-reference/${f}`, import.meta.url);
const plan = (over, today = "2026-11-13") => planFiling({ ...GOOD, ...over }, today);

test("prompt and schema are byte-identical to the Make reference files", () => {
	assert.equal(SYSTEM_PROMPT, readFileSync(ref("classification-prompt.fr.txt"), "utf8"));
	assert.deepEqual(RESPONSE_SCHEMA, JSON.parse(readFileSync(ref("classification-schema.make.json"), "utf8")));
});

test("ordinary correspondence is filed under person/year", () => {
	const p = plan({});
	assert.equal(p.folder, "/Courants/CUR/SCHAFEITEL Christophe/2026");
	assert.equal(p.fileName, "20261110 - JPX - Convocation audience curatelle.pdf");
	assert.equal(p.needsReview, false);
});

test("FACTURE always /COMPTA; RAPPEL only with action AND amount; DECOMPTE never", () => {
	assert.match(plan({ document_type: "FACTURE" }).folder, /\/2026\/COMPTA$/);
	assert.match(plan({ document_type: "RAPPEL", action_required: true, amount_chf: 12 }).folder, /COMPTA$/);
	assert.doesNotMatch(plan({ document_type: "RAPPEL", action_required: true, amount_chf: null }).folder, /COMPTA/);
	assert.doesNotMatch(plan({ document_type: "RAPPEL", action_required: false, amount_chf: 12 }).folder, /COMPTA/);
	assert.doesNotMatch(plan({ document_type: "DECOMPTE", amount_chf: 50 }).folder, /COMPTA/);
});

test("unknown person, date, issuer or DIVERS route to the review inbox", () => {
	for (const over of [{ person_path: null }, { document_date_iso: null }, { issuer: null }, { document_type: "DIVERS" }, { needs_review: true, review_reason: "x" }]) {
		const p = plan(over);
		assert.equal(p.needsReview, true, JSON.stringify(over));
		assert.equal(p.folder, "/Courants/_SCAN_INBOX");
	}
	assert.equal(plan({ person_path: null }).reviewReason, "Personne concernée non identifiable");
	assert.equal(plan({ document_date_iso: null }).reviewReason, "Date du document inconnue");
	assert.equal(plan({ issuer: null, review_reason: null }).reviewReason, "Vérification manuelle requise");
});

test("missing date: processing date in the name, '(check date)', label cut to 47", () => {
	const p = plan({ document_date_iso: null, file_label: "x".repeat(80) });
	assert.equal(p.fileName, `20261113 - JPX - ${"x".repeat(47)} (check date).pdf`);
	assert.equal(p.docYear, "2026");
});

test("processing date is the frozen one, not 'now' (midnight / new-year retry)", () => {
	const p = plan({ document_date_iso: null }, "2026-12-31");
	assert.match(p.fileName, /^20261231 - /);
});

test("BERCLAZ_Valentin keeps the Make mapping under /Courants/CUR", () => {
	assert.equal(plan({ person_path: "BERCLAZ_Valentin" }).folder, "/Courants/CUR/BERCLAZ_Valentin/2026");
});

test("short issuer and label are made path-safe", () => {
	assert.equal(normalizeShortIssuer("Ass. Cpl é"), "ASSCPLE");
	assert.equal(normalizeShortIssuer("abcdefghijklmnop"), "ABCDEFGHIJ");
	assert.equal(normalizeShortIssuer(""), "INCONNU");
	assert.equal(safeText('a/b\\c:d*e?f"g<h>i|j. '), "a b c d e f g h i j");
	const p = plan({ file_label: 'Facture: "EMS" / avril.' });
	assert.equal(p.safeLabel, "Facture EMS avril");
});

test("uncertain deadline or future date forces review (never filed as confirmed)", () => {
	assert.equal(plan({ deadline_iso: "2026-10-01" }).needsReview, true);
	assert.equal(plan({ deadline_iso: "2026-10-01" }).folder, "/Courants/_SCAN_INBOX");
	assert.equal(plan({ document_date_iso: "2027-01-05" }).needsReview, true);
	assert.equal(plan({ deadline_iso: "2026-12-01" }).needsReview, false);
});

test("validator enforces the 13-field contract", () => {
	assert.equal(validateClassification(GOOD).ok, true);
	const bad = (over, reason) => assert.deepEqual(validateClassification({ ...GOOD, ...over }), { ok: false, reason });
	bad({ person_path: "Somebody Else" }, "enum:person_path");
	bad({ document_type: "LETTER" }, "enum:document_type");
	bad({ document_date_iso: "2026-02-30" }, "date:document_date_iso");
	bad({ amount_chf: -1 }, "range:amount_chf");
	bad({ needs_review: "no" }, "type:needs_review");
	bad({ short_issuer: null }, "type:short_issuer");
	const { person_path: _omit, ...missing } = GOOD;
	assert.deepEqual(validateClassification(missing), { ok: false, reason: "missing:person_path" });
	assert.equal(validateClassification([]).ok, false);
});

test("helpers: conflict name and Dropbox link", () => {
	assert.equal(conflictName("a.pdf", "jABCDEF0123"), "a [ABCDEF].pdf");
	assert.equal(dropboxHomeLink("/Courants/CUR/ÖZTÜRK Haci Ali/2026/a b.pdf"), "https://www.dropbox.com/home/Courants/CUR/%C3%96ZT%C3%9CRK%20Haci%20Ali/2026/a%20b.pdf");
});
