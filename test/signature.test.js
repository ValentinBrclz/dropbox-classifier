import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifySignature } from "../src/signature.ts";

const sign = (body, secret) => createHmac("sha256", secret).update(body).digest("hex");

test("valid signature accepted, tampered body / wrong secret / empty header rejected", async () => {
	const body = '{"list_folder":{"accounts":["dbid:1"]}}';
	assert.equal(await verifySignature(body, sign(body, "s3cret"), "s3cret"), true);
	assert.equal(await verifySignature(body, sign(body, "s3cret").toUpperCase(), "s3cret"), true);
	assert.equal(await verifySignature(`${body} `, sign(body, "s3cret"), "s3cret"), false);
	assert.equal(await verifySignature(body, sign(body, "other"), "s3cret"), false);
	assert.equal(await verifySignature(body, "", "s3cret"), false);
});
