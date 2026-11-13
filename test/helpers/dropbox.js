// In-memory Dropbox: implements the endpoints used by src/dropbox.ts over a fetch mock.
import { createHash } from "node:crypto";

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const err409 = (summary) => json({ error_summary: summary, error: {} }, 409);
export const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function makeDropbox() {
	let seq = 0;
	let revN = 0;
	const files = new Map(); // id -> {id,name,path,rev,bytes}
	const folders = new Set(["", "/apps/incomingscans"]);
	const log = []; // [{ep, args}]
	const events = []; // {seq, id}
	const failures = []; // {ep, times, status, afterApply}
	const state = { pageSize: 1000, resetNext: false, calls: {} };
	const lower = (p) => p.toLowerCase();
	const parent = (p) => p.slice(0, p.lastIndexOf("/"));
	const display = (f) => f.path;

	const meta = (f) => ({
		".tag": "file",
		id: f.id,
		name: f.path.slice(f.path.lastIndexOf("/") + 1),
		path_lower: lower(f.path),
		path_display: f.path,
		rev: f.rev,
		size: f.bytes.length,
		server_modified: "2026-11-01T10:00:00Z",
		content_hash: hashOf(f.bytes),
	});
	const byRef = (p) => {
		if (p.startsWith("id:")) return [...files.values()].find((f) => f.id === p);
		if (p.startsWith("rev:")) return [...files.values()].find((f) => f.rev === p.slice(4));
		return [...files.values()].find((f) => lower(f.path) === lower(p));
	};
	const mkdirs = (p) => {
		let cur = "";
		for (const seg of p.split("/").filter(Boolean)) {
			cur += `/${lower(seg)}`;
			folders.add(cur);
		}
	};

	const api = {
		/** Put a file in the inbox (or anywhere). Returns its entry. */
		add(path, bytes = `%PDF-1.7 ${Math.random()}`, id) {
			const f = { id: id ?? `id:${++seq}`, path, rev: `rev${++revN}`, bytes: Buffer.from(bytes) };
			files.set(f.id, f);
			mkdirs(parent(path));
			events.push({ seq: events.length + 1, id: f.id });
			return meta(f);
		},
		files,
		folders,
		log,
		state,
		list: (folder) => [...files.values()].filter((f) => lower(parent(f.path)) === lower(folder)).map(meta),
		at: (path) => [...files.values()].filter((f) => lower(f.path) === lower(path)),
		/** Make the next `times` calls to an endpoint fail with `status` (before applying). */
		fail(ep, status = 500, times = 1) {
			failures.push({ ep, times, status, afterApply: false });
		},
		/** Apply the next call to the endpoint, but report a 500 (lost acknowledgement). */
		loseAck(ep, times = 1) {
			failures.push({ ep, times, status: 500, afterApply: true });
		},
		clearFailures: () => {
			failures.length = 0;
		},
	};

	const fetchFn = async (url, init = {}) => {
		const u = new URL(url);
		if (u.hostname === "api.dropbox.com") return json({ access_token: "tok", expires_in: 14400 });
		const ep = u.pathname.replace(/^\/2/, "");
		state.calls[ep] = (state.calls[ep] ?? 0) + 1;
		const args = ep === "/files/download" ? JSON.parse(init.headers["Dropbox-API-Arg"]) : JSON.parse(init.body ?? "{}");
		log.push({ ep, args });

		const fail = failures.find((x) => x.ep === ep && x.times > 0);
		if (fail && !fail.afterApply) {
			fail.times--;
			return new Response("{}", { status: fail.status });
		}
		const res = handle(ep, args);
		if (fail?.afterApply) {
			fail.times--;
			return new Response("{}", { status: fail.status });
		}
		return res;
	};

	function handle(ep, a) {
		switch (ep) {
			case "/files/list_folder": {
				const entries = api.list(a.path);
				const cur = `c${events.length}:${lower(a.path)}`;
				return page(entries, cur);
			}
			case "/files/list_folder/continue": {
				if (state.resetNext) {
					state.resetNext = false;
					return err409("reset/..");
				}
				if (a.cursor.startsWith("p")) {
					const [, off, folder, end] = a.cursor.match(/^p(\d+):(.*):(\d+)$/);
					const all = JSON.parse(state.pages ?? "[]");
					return page(all.slice(Number(off)), `c${end}:${folder}`, Number(off));
				}
				const [, seqStr, folder] = a.cursor.match(/^c(\d+):(.*)$/);
				const entries = events
					.filter((e) => e.seq > Number(seqStr))
					.map((e) => files.get(e.id))
					.filter((f) => f && lower(parent(f.path)) === folder)
					.map(meta);
				return page(entries, `c${events.length}:${folder}`);
			}
			case "/files/get_metadata": {
				const f = byRef(a.path);
				if (!f) return err409("path/not_found/..");
				return json(meta(f));
			}
			case "/files/download": {
				const f = byRef(a.path);
				if (!f) return err409("path/not_found/..");
				return new Response(f.bytes, { status: 200, headers: { "content-length": String(f.bytes.length) } });
			}
			case "/files/create_folder_v2": {
				if (folders.has(lower(a.path))) return err409("path/conflict/folder/..");
				if (api.at(a.path).length) return err409("path/conflict/file/..");
				mkdirs(a.path);
				return json({ metadata: { id: "fold", name: a.path } });
			}
			case "/files/copy_v2":
			case "/files/move_v2": {
				const src = byRef(a.from_path);
				if (!src) return err409("from_lookup/not_found/..");
				if (api.at(a.to_path).length || folders.has(lower(a.to_path))) return err409("to/conflict/file/..");
				if (!folders.has(lower(parent(a.to_path)))) return err409("to/path/not_found/..");
				if (ep === "/files/move_v2") {
					src.path = a.to_path;
					events.push({ seq: events.length + 1, id: src.id });
					return json({ metadata: meta(src) });
				}
				const copy = { id: `id:${++seq}`, path: a.to_path, rev: `rev${++revN}`, bytes: src.bytes };
				files.set(copy.id, copy);
				return json({ metadata: meta(copy) });
			}
			default:
				return json({ error_summary: "unknown_endpoint" }, 400);
		}
	}

	function page(entries, cursor) {
		const size = state.pageSize;
		if (entries.length <= size) return json({ entries, cursor, has_more: false });
		state.pages = JSON.stringify(entries);
		const end = cursor.match(/^c(\d+):/)[1];
		const folder = cursor.replace(/^c\d+:/, "");
		return json({ entries: entries.slice(0, size), cursor: `p${size}:${folder}:${end}`, has_more: true });
	}

	return { fetchFn, api };
}
