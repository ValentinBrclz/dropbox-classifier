/**
 * Dropbox API client: OAuth refresh-token handling (cached in memory and KV),
 * RPC with bounded retries, listing, metadata, download, folder creation,
 * server-side copy and move.
 *
 * Errors are mapped to {@link ClassifierError} categories. Messages and codes
 * never contain paths, names or tokens.
 */

import { backoffMs, ClassifierError, retryAfterMs, sleep } from "./util.ts";

export interface DbxEntry {
	".tag": "file" | "folder" | "deleted";
	id: string;
	name: string;
	path_lower: string;
	path_display: string;
	rev?: string;
	size?: number;
	server_modified?: string;
	content_hash?: string;
}

export interface DbxListResult {
	entries: DbxEntry[];
	cursor: string;
	has_more: boolean;
}

/** Dropbox 409 error, with the machine `error_summary` (e.g. `to/conflict/file/..`). */
export class DropboxApiError extends ClassifierError {
	summary: string;
	constructor(summary: string) {
		super("permanent", `dropbox_409`, `Dropbox 409 ${summary}`);
		this.summary = summary;
	}
}

export interface DropboxCredentials {
	appKey: string;
	appSecret: string;
	refreshToken: string;
}

export interface KvLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

export interface DropboxOptions {
	credentials: DropboxCredentials;
	kv?: KvLike;
	/** Injected in tests. */
	fetchFn?: typeof fetch;
	/** Overridable for local mock servers. */
	apiBase?: string;
	contentBase?: string;
	oauthUrl?: string;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

const TOKEN_KEY = "classifier:dbx_token";

export class Dropbox {
	private o: Required<Omit<DropboxOptions, "kv">> & { kv?: KvLike };
	private memToken?: { token: string; exp: number };

	constructor(opts: DropboxOptions) {
		this.o = {
			fetchFn: (...a) => fetch(...a),
			apiBase: "https://api.dropboxapi.com/2",
			contentBase: "https://content.dropboxapi.com/2",
			oauthUrl: "https://api.dropbox.com/oauth2/token",
			maxRetries: 3,
			maxRetryDelayMs: 5000,
			...opts,
		};
	}

	/* ---------------------------- auth ------------------------------------ */

	private async token(force = false): Promise<string> {
		if (!force) {
			if (this.memToken && Date.now() < this.memToken.exp) return this.memToken.token;
			const cached = parseToken(await this.o.kv?.get(TOKEN_KEY).catch(() => null));
			if (cached && Date.now() < cached.exp) {
				this.memToken = cached;
				return cached.token;
			}
		}
		const c = this.o.credentials;
		let res: Response;
		try {
			res = await this.o.fetchFn(this.o.oauthUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: c.refreshToken.trim(),
					client_id: c.appKey.trim(),
					client_secret: c.appSecret.trim(),
				}),
			});
		} catch {
			throw new ClassifierError("transient", "dbx_oauth_network");
		}
		if (!res.ok) {
			await res.body?.cancel();
			// 400/401 invalid_grant: the refresh token was revoked or is wrong.
			throw new ClassifierError(
				res.status >= 500 || res.status === 429 ? "transient" : "auth",
				`dbx_oauth_${res.status}`,
			);
		}
		const data = (await res.json()) as { access_token: string; expires_in: number };
		this.memToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
		await this.o.kv?.put(TOKEN_KEY, JSON.stringify(this.memToken)).catch(() => undefined);
		return data.access_token;
	}

	/* ---------------------------- transport -------------------------------- */

	/** fetch with auth, one token refresh on 401, bounded retry on 429/5xx/network. */
	private async send(
		url: string,
		makeInit: (token: string) => RequestInit,
	): Promise<Response> {
		let refreshed = false;
		for (let attempt = 0; ; attempt++) {
			const token = await this.token();
			let res: Response | undefined;
			try {
				res = await this.o.fetchFn(url, makeInit(token));
			} catch {
				if (attempt >= this.o.maxRetries) throw new ClassifierError("transient", "dbx_network");
				await sleep(Math.min(backoffMs(attempt), this.o.maxRetryDelayMs));
				continue;
			}
			if (res.status === 401 && !refreshed) {
				refreshed = true;
				await res.body?.cancel();
				await this.token(true);
				continue;
			}
			if (res.status === 401) {
				await res.body?.cancel();
				throw new ClassifierError("auth", "dbx_401");
			}
			if (res.status === 429 || res.status >= 500) {
				if (attempt >= this.o.maxRetries) {
					await res.body?.cancel();
					throw new ClassifierError("transient", `dbx_${res.status}`);
				}
				const wait = retryAfterMs(res, this.o.maxRetryDelayMs) ?? Math.min(backoffMs(attempt, 1000), this.o.maxRetryDelayMs);
				await res.body?.cancel();
				await sleep(wait);
				continue;
			}
			return res;
		}
	}

	/** Map a non-2xx, non-retryable response to an error. */
	private async fail(res: Response, endpoint: string): Promise<never> {
		let summary = "";
		try {
			const b = (await res.json()) as { error_summary?: string };
			summary = String(b.error_summary ?? "").slice(0, 120);
		} catch {
			// not JSON
		}
		if (res.status === 409) throw new DropboxApiError(summary || endpoint);
		if (res.status === 403 && summary.startsWith("missing_scope")) {
			throw new ClassifierError("config", "dbx_missing_scope");
		}
		throw new ClassifierError("permanent", `dbx_${res.status}`, `Dropbox ${endpoint} ${res.status} ${summary}`);
	}

	private async rpc<T>(endpoint: string, args: unknown): Promise<T> {
		const res = await this.send(`${this.o.apiBase}${endpoint}`, (t) => ({
			method: "POST",
			headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
			body: JSON.stringify(args),
		}));
		if (!res.ok) return this.fail(res, endpoint);
		return (await res.json()) as T;
	}

	/* ---------------------------- operations ------------------------------- */

	async listFolder(path: string): Promise<DbxListResult> {
		return this.rpc("/files/list_folder", { path, recursive: false, include_deleted: false });
	}

	async listContinue(cursor: string): Promise<DbxListResult> {
		return this.rpc("/files/list_folder/continue", { cursor });
	}

	/** Metadata by path or `id:`; `null` when the path does not exist. */
	async getMetadata(path: string): Promise<DbxEntry | null> {
		try {
			return await this.rpc<DbxEntry>("/files/get_metadata", { path });
		} catch (e) {
			if (e instanceof DropboxApiError && e.summary.startsWith("path/not_found")) return null;
			throw e;
		}
	}

	/**
	 * Stream a file. Use `rev:<rev>` to read exactly the registered version.
	 * @throws {DropboxApiError} `path/not_found` when the file or rev is gone.
	 */
	async download(path: string): Promise<Response> {
		const res = await this.send(`${this.o.contentBase}/files/download`, (t) => ({
			method: "POST",
			headers: { Authorization: `Bearer ${t}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
		}));
		if (!res.ok) return this.fail(res, "/files/download");
		return res;
	}

	/** Create a folder (and missing parents). An existing folder is success. */
	async ensureFolder(path: string): Promise<void> {
		try {
			await this.rpc("/files/create_folder_v2", { path, autorename: false });
		} catch (e) {
			// Existing folder: path/conflict/folder. A *file* in the way is a real conflict.
			if (e instanceof DropboxApiError && e.summary.startsWith("path/conflict/folder")) return;
			throw e;
		}
	}

	/**
	 * Server-side copy; never overwrites.
	 * @returns The new entry, or `"conflict"` when the target name is taken.
	 */
	async copy(from: string, to: string): Promise<DbxEntry | "conflict"> {
		try {
			const r = await this.rpc<{ metadata: DbxEntry }>("/files/copy_v2", {
				from_path: from,
				to_path: to,
				autorename: false,
				allow_ownership_transfer: false,
			});
			return r.metadata;
		} catch (e) {
			if (e instanceof DropboxApiError && e.summary.startsWith("to/conflict")) return "conflict";
			throw e;
		}
	}

	/** Server-side move; never overwrites. `"conflict"` when the target name is taken. */
	async move(from: string, to: string): Promise<DbxEntry | "conflict"> {
		try {
			const r = await this.rpc<{ metadata: DbxEntry }>("/files/move_v2", {
				from_path: from,
				to_path: to,
				autorename: false,
				allow_ownership_transfer: false,
			});
			return r.metadata;
		} catch (e) {
			if (e instanceof DropboxApiError && e.summary.startsWith("to/conflict")) return "conflict";
			throw e;
		}
	}
}

function parseToken(raw: string | null | undefined): { token: string; exp: number } | undefined {
	if (!raw) return undefined;
	try {
		const p = JSON.parse(raw) as { token?: unknown; exp?: unknown };
		if (typeof p.token === "string" && typeof p.exp === "number") return { token: p.token, exp: p.exp };
	} catch {
		// corrupted: refresh
	}
	return undefined;
}
