import assert from "node:assert/strict";
import test from "node:test";
import { assertConfigured } from "../src/config.ts";

const ok = { mode: "dry_run", folders: "/Apps/Inbox", archiveFolder: "/Apps/Inbox/_sorted" };
const code = (s) => {
	try {
		assertConfigured(s);
		return "ok";
	} catch (e) {
		return e.code;
	}
};

test("valid folder settings pass", () => {
	assert.equal(code(ok), "ok");
	assert.equal(code({ ...ok, folders: "/A, /B" }), "ok");
});

test("missing or root source fails closed (never the Dropbox root)", () => {
	assert.equal(code({ ...ok, folders: "" }), "no_source");
	assert.equal(code({ ...ok, folders: "   " }), "no_source");
	assert.equal(code({ ...ok, folders: "/" }), "source_is_root");
	assert.equal(code({ ...ok, folders: "relative/path" }), "bad_source");
});

test("missing or root archive folder fails closed", () => {
	assert.equal(code({ ...ok, archiveFolder: "" }), "bad_archive_folder");
	assert.equal(code({ ...ok, archiveFolder: "/" }), "bad_archive_folder");
	assert.equal(code({ ...ok, archiveFolder: "no-slash" }), "bad_archive_folder");
});
