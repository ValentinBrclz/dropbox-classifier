import assert from "node:assert/strict";
import test from "node:test";
import { log, setLogLevel } from "../src/util.ts";

function capture(t) {
	const lines = [];
	const saved = {};
	for (const m of ["log", "info", "warn", "error"]) {
		saved[m] = console[m];
		console[m] = (...a) => lines.push({ m, text: a.join(" ") });
	}
	t.after(() => {
		Object.assign(console, saved);
		setLogLevel(undefined);
	});
	return lines;
}
const all = () => {
	log("info", "i");
	log("warn", "w");
	log("error", "e");
};

test("default level is warn: info is silent", (t) => {
	const lines = capture(t);
	setLogLevel(undefined);
	all();
	assert.deepEqual(lines.map((l) => l.m), ["warn", "error"]);
});

test("LOG_LEVEL=info adds info, written with console.info", (t) => {
	const lines = capture(t);
	setLogLevel("info");
	all();
	assert.deepEqual(lines.map((l) => l.m), ["info", "warn", "error"]);
});

test("LOG_LEVEL=error keeps failures only; unknown values fall back to warn", (t) => {
	const lines = capture(t);
	setLogLevel("ERROR");
	all();
	assert.deepEqual(lines.map((l) => l.m), ["error"]);
	lines.length = 0;
	setLogLevel("verbose");
	all();
	assert.deepEqual(lines.map((l) => l.m), ["warn", "error"]);
});
