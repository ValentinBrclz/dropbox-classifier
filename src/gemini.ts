/**
 * Gemini client: Files API upload (streamed, no base64 / no buffering in the
 * Worker), generateContent with the verbatim Make prompt and schema, deletion
 * of the uploaded file, and the primary -> fallback policy.
 *
 * Data handling: the PDF is uploaded to Google's Files API (Google retains it
 * for 48 h unless deleted; we delete it right after classification).
 * Display names are job ids, never document names.
 */

import { type Classification, validateClassification } from "./classification.ts";
import { SYSTEM_PROMPT, USER_TEXT } from "./prompt.ts";
import { RESPONSE_SCHEMA } from "./schema.ts";
import { ClassifierError, sleep } from "./util.ts";

export interface GeminiConfig {
	apiKey: string;
	primaryModel: string;
	fallbackModel: string;
	/** "flex" reproduces Make; empty string = standard tier. Unverified on generateContent. */
	serviceTier: string;
	/** Per-call timeout (flex latency target is 1-15 min). */
	timeoutMs: number;
	baseUrl?: string;
	fetchFn?: typeof fetch;
}

export interface UploadedFile {
	name: string;
	uri: string;
	mimeType: string;
}

const base = (c: GeminiConfig) => c.baseUrl ?? "https://generativelanguage.googleapis.com";
const f = (c: GeminiConfig) => c.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

/** Map an HTTP status of a Gemini call to a failure category. */
function httpError(status: number, code: string): ClassifierError {
	if (status === 401 || status === 403) return new ClassifierError("auth", `${code}_${status}`);
	if (status === 429 || status >= 500) return new ClassifierError("transient", `${code}_${status}`);
	return new ClassifierError("permanent", `${code}_${status}`);
}

/**
 * Wrap a body so it is sent with a fixed Content-Length, streaming
 * (workerd `FixedLengthStream`). Falls back to buffering outside workerd (tests).
 */
async function fixedLengthBody(src: Response, size: number): Promise<BodyInit> {
	const FLS = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
	if (FLS && src.body) {
		const { readable, writable } = new FLS(size);
		// Not awaited: it runs while fetch consumes `readable`. Errors surface through fetch.
		src.body.pipeTo(writable).catch(() => undefined);
		return readable;
	}
	return await src.arrayBuffer();
}

/**
 * Upload a PDF response body to the Files API (resumable protocol, one
 * start call + one upload/finalize call).
 *
 * @param pdf - Dropbox download response.
 * @param size - Exact byte length (from Dropbox metadata).
 * @param displayName - Opaque label (job id).
 */
export async function uploadPdf(
	c: GeminiConfig,
	pdf: Response,
	size: number,
	displayName: string,
): Promise<UploadedFile> {
	let start: Response;
	try {
		start = await f(c)(`${base(c)}/upload/v1beta/files`, {
			method: "POST",
			headers: {
				"x-goog-api-key": c.apiKey,
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(size),
				"X-Goog-Upload-Header-Content-Type": "application/pdf",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		await pdf.body?.cancel();
		throw new ClassifierError("transient", "gemini_upload_network");
	}
	const uploadUrl = start.headers.get("x-goog-upload-url");
	await start.body?.cancel();
	if (!start.ok || !uploadUrl) {
		await pdf.body?.cancel();
		throw httpError(start.ok ? 502 : start.status, "gemini_upload_start");
	}

	let done: Response;
	try {
		done = await f(c)(uploadUrl, {
			method: "POST",
			headers: {
				"Content-Length": String(size),
				"X-Goog-Upload-Offset": "0",
				"X-Goog-Upload-Command": "upload, finalize",
			},
			body: await fixedLengthBody(pdf, size),
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw new ClassifierError("transient", "gemini_upload_network");
	}
	if (!done.ok) {
		await done.body?.cancel();
		throw httpError(done.status, "gemini_upload");
	}
	const meta = (await done.json()) as { file?: { name?: string; uri?: string; mimeType?: string; state?: string } };
	const file = meta.file;
	if (!file?.name || !file.uri) throw new ClassifierError("transient", "gemini_upload_response");

	// PDFs are normally ACTIVE at once; wait briefly if not.
	let state = file.state ?? "ACTIVE";
	for (let i = 0; state === "PROCESSING" && i < 5; i++) {
		await sleep(1000);
		const r = await f(c)(`${base(c)}/v1beta/${file.name}`, { headers: { "x-goog-api-key": c.apiKey } });
		if (!r.ok) {
			await r.body?.cancel();
			break;
		}
		state = ((await r.json()) as { state?: string }).state ?? "ACTIVE";
	}
	if (state === "FAILED") throw new ClassifierError("permanent", "gemini_file_failed");
	return { name: file.name, uri: file.uri, mimeType: file.mimeType ?? "application/pdf" };
}

/** Best-effort deletion of an uploaded file. Never throws. */
export async function deleteFile(c: GeminiConfig, name: string): Promise<boolean> {
	try {
		const r = await f(c)(`${base(c)}/v1beta/${name}`, {
			method: "DELETE",
			headers: { "x-goog-api-key": c.apiKey },
			signal: AbortSignal.timeout(15_000),
		});
		await r.body?.cancel();
		return r.ok || r.status === 404;
	} catch {
		return false;
	}
}

export type Generated =
	| { kind: "ok"; value: Classification }
	| { kind: "invalid"; reason: string };

/**
 * One generateContent call.
 *
 * @returns A validated classification, or `invalid` when the model answered
 *   but the answer is unusable (bad JSON, schema violation, blocked, truncated).
 * @throws {ClassifierError} On transport/HTTP failures (transient, auth, ...).
 */
export async function generate(c: GeminiConfig, model: string, file: UploadedFile): Promise<Generated> {
	const body: Record<string, unknown> = {
		systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
		contents: [
			{
				role: "user",
				parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }, { text: USER_TEXT }],
			},
		],
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: RESPONSE_SCHEMA,
			responseModalities: ["TEXT"],
		},
	};
	if (c.serviceTier) body.serviceTier = c.serviceTier;

	let res: Response;
	try {
		res = await f(c)(`${base(c)}/v1beta/models/${model}:generateContent`, {
			method: "POST",
			headers: { "x-goog-api-key": c.apiKey, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(c.timeoutMs),
		});
	} catch (e) {
		const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
		throw new ClassifierError("transient", timeout ? "ai_timeout" : "ai_network");
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw httpError(res.status, "gemini_generate");
	}

	let data: {
		candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
		promptFeedback?: { blockReason?: string };
	};
	try {
		data = await res.json();
	} catch {
		return { kind: "invalid", reason: "response_not_json" };
	}
	if (data.promptFeedback?.blockReason) return { kind: "invalid", reason: "blocked" };
	const cand = data.candidates?.[0];
	if (!cand) return { kind: "invalid", reason: "no_candidate" };
	if (cand.finishReason && cand.finishReason !== "STOP") return { kind: "invalid", reason: `finish:${cand.finishReason}` };
	const text = cand.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "invalid", reason: "output_not_json" };
	}
	const v = validateClassification(parsed);
	return v.ok ? { kind: "ok", value: v.value } : { kind: "invalid", reason: v.reason };
}

export interface ClassifyOutcome {
	result: Generated;
	model: string;
}

/**
 * Primary -> fallback policy.
 *
 * - Transport error on the primary (incl. timeout): the primary is tried once
 *   more, then the fallback model is used (Make used the fallback on any error).
 * - Invalid output: ONE regeneration with the same model; if still invalid the
 *   caller routes the document to manual review.
 * - auth / config errors are never retried or masked by the fallback.
 * - Both models failing on transport errors throws a transient error so the
 *   Workflow step retries later; the uploaded file is reused.
 */
export async function classifyWithFallback(c: GeminiConfig, file: UploadedFile): Promise<ClassifyOutcome> {
	const attemptModel = async (model: string): Promise<Generated> => {
		const first = await generate(c, model, file);
		if (first.kind === "ok") return first;
		return generate(c, model, file); // controlled regeneration
	};

	let lastError: ClassifierError | undefined;
	for (const [model, tries] of [
		[c.primaryModel, 2],
		[c.fallbackModel, 1],
	] as const) {
		for (let i = 0; i < tries; i++) {
			try {
				return { result: await attemptModel(model), model };
			} catch (e) {
				if (!(e instanceof ClassifierError)) throw e;
				if (e.category === "auth" || e.category === "config") throw e;
				lastError = e;
			}
		}
	}
	throw lastError ?? new ClassifierError("transient", "ai_unavailable");
}
