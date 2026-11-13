import assert from "node:assert/strict";
import test from "node:test";
import { generate, uploadPdf } from "../src/gemini.ts";
import { GOOD } from "./helpers/gemini.js";

test("AI Gateway: generateContent goes through the gateway, upload stays direct", async () => {
	const urls = [];
	const headers = [];
	const fetchFn = async (url, init = {}) => {
		urls.push(String(url));
		headers.push(init.headers ?? {});
		const u = new URL(url);
		if (u.pathname === "/upload/v1beta/files") return new Response("{}", { headers: { "x-goog-upload-url": "https://upload.test/u" } });
		if (u.hostname === "upload.test") return new Response(JSON.stringify({ file: { name: "files/f", uri: "https://g/f", mimeType: "application/pdf", state: "ACTIVE" } }));
		return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] }, finishReason: "STOP" }] }));
	};
	const c = {
		apiKey: "K",
		primaryModel: "P",
		fallbackModel: "F",
		serviceTier: "",
		timeoutMs: 1000,
		fetchFn,
		generateBaseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/",
		generateHeaders: { "cf-aig-authorization": "Bearer T" },
	};
	const file = await uploadPdf(c, new Response("%PDF-1"), 6, "jid");
	const out = await generate(c, "P", file);
	assert.equal(out.kind, "ok");
	assert.ok(urls[0].startsWith("https://generativelanguage.googleapis.com/upload/"));
	const gen = urls.findIndex((u) => u.includes(":generateContent"));
	assert.equal(urls[gen], "https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/models/P:generateContent");
	assert.equal(headers[gen]["cf-aig-authorization"], "Bearer T");
	assert.equal(headers[gen]["x-goog-api-key"], "K");
});

test("without a gateway, generateContent calls Google directly", async () => {
	let url = "";
	const fetchFn = async (u) => {
		url = String(u);
		return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] }, finishReason: "STOP" }] }));
	};
	await generate({ apiKey: "K", primaryModel: "P", fallbackModel: "F", serviceTier: "", timeoutMs: 1000, fetchFn }, "P", { name: "n", uri: "u", mimeType: "application/pdf" });
	assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/P:generateContent");
});
