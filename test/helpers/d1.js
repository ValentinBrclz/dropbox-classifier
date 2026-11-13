// D1-compatible shim over node:sqlite so tests exercise the real SQL, constraints and indexes.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const clean = (v) => (v === undefined ? null : v);

export function makeD1(opts = {}) {
	const db = new DatabaseSync(":memory:");
	for (const f of readdirSync(new URL("../../migrations/", import.meta.url)).sort()) {
		db.exec(readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8"));
	}
	const stmt = (sql, params = []) => ({
		sql,
		bind: (...p) => stmt(sql, p.map(clean)),
		_run() {
			opts.beforeRun?.(sql);
			const r = db.prepare(sql).run(...params);
			return { success: true, meta: { changes: Number(r.changes) }, results: [] };
		},
		async run() {
			return this._run();
		},
		async first() {
			opts.beforeRun?.(sql);
			const r = db.prepare(sql).get(...params);
			return r ? { ...r } : null;
		},
		async all() {
			opts.beforeRun?.(sql);
			return { success: true, meta: {}, results: db.prepare(sql).all(...params).map((r) => ({ ...r })) };
		},
	});
	return {
		raw: db,
		prepare: (sql) => stmt(sql),
		async batch(stmts) {
			db.exec("BEGIN");
			try {
				const out = stmts.map((s) => s._run());
				db.exec("COMMIT");
				return out;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	};
}
