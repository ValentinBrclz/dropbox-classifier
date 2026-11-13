// Fake Gemini Files + generateContent endpoints with scripted responses.
export const GOOD = {
	person_path: "SCHAFEITEL Christophe",
	person_full_name: "Christophe Schafeitel",
	document_date_iso: "2026-11-10",
	document_type: "CONVOCATION",
	issuer: "Justice de Paix",
	short_issuer: "JPX",
	file_label: "Convocation audience curatelle",
	needs_review: false,
	review_reason: null,
	action_required: false,
	deadline_iso: null,
	amount_chf: null,
	document_reference: null,
};

const reply = (obj) =>
	new Response(
		JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }, finishReason: "STOP" }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

export function makeGemini() {
	const g = { uploads: 0, generate: [], deleted: [], script: [], uploadStatus: 200, current: { ...GOOD } };
	g.fetchFn = async (url, init = {}) => {
		const u = new URL(url);
		if (u.pathname === "/upload/v1beta/files") {
			if (g.uploadStatus !== 200) return new Response("{}", { status: g.uploadStatus });
			return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://upload.test/u" } });
		}
		if (u.hostname === "upload.test") {
			g.uploads++;
			return new Response(
				JSON.stringify({ file: { name: `files/f${g.uploads}`, uri: `https://g.test/files/f${g.uploads}`, mimeType: "application/pdf", state: "ACTIVE" } }),
				{ status: 200 },
			);
		}
		if (init.method === "DELETE") {
			g.deleted.push(u.pathname);
			return new Response(null, { status: 200 });
		}
		const model = u.pathname.match(/models\/(.+):generateContent/)?.[1];
		g.generate.push({ model, body: JSON.parse(init.body) });
		const next = g.script.shift();
		if (next === "timeout") throw new DOMException("t", "TimeoutError");
		if (typeof next === "number") return new Response("{}", { status: next });
		if (typeof next === "function") return next(model);
		if (next !== undefined) return reply(next);
		return reply(g.current);
	};
	return g;
}
