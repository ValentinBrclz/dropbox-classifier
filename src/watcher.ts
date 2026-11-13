/**
 * Dropbox change detection -> durable job registration.
 *
 * Invariant: a folder cursor is advanced only AFTER every eligible PDF of the
 * listing is registered in D1. Registration is idempotent (unique file
 * id + rev), so concurrent webhook/cron runs and cursor resets cannot lose or
 * duplicate work.
 */

import { advanceCursor, getCursor, registerJobs, replaceCursor } from "./db.ts";
import { type DbxEntry, type DbxListResult, Dropbox, DropboxApiError } from "./dropbox.ts";
import { log } from "./util.ts";

/** Normalise `DROPBOX_SOURCE` (comma separated, root = ""). */
export function parseSourceFolders(raw: string | undefined): string[] {
	const parts = (raw ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return [""];
	const unique = new Map<string, string>();
	for (const part of parts) {
		const t = part.trim();
		if (t !== "/" && !t.startsWith("/")) throw new Error(`DROPBOX_SOURCE paths must start with "/"`);
		const folder = t === "/" ? "" : t.replace(/\/+$/, "");
		unique.set(folder.toLowerCase(), folder);
	}
	return [...unique.values()];
}

/** `.pdf` files located directly in the watched folder. */
export function isTargetPdf(entry: DbxEntry, folderLower: string): boolean {
	if (entry[".tag"] !== "file" || !entry.rev) return false;
	if (!entry.name.toLowerCase().endsWith(".pdf")) return false;
	return entry.path_lower.slice(0, entry.path_lower.lastIndexOf("/")) === folderLower;
}

function isCursorReset(e: unknown): boolean {
	return e instanceof DropboxApiError && e.summary.startsWith("reset");
}

async function drain(dbx: Dropbox, first: DbxListResult): Promise<{ entries: DbxEntry[]; cursor: string }> {
	const entries = [...first.entries];
	let page = first;
	while (page.has_more) {
		page = await dbx.listContinue(page.cursor);
		entries.push(...page.entries);
	}
	return { entries, cursor: page.cursor };
}

export interface ScanDeps {
	db: D1Database;
	dbx: Dropbox;
	folders: string[];
	mode: "live" | "dry_run";
	now?: () => number;
}

/**
 * Scan every watched folder and register new PDFs. A failure in one folder is
 * logged and does not block the others; the failed folder keeps its cursor.
 *
 * @returns Number of newly registered jobs.
 */
export async function scanFolders(deps: ScanDeps): Promise<{ registered: number; failedFolders: number }> {
	let registered = 0;
	let failedFolders = 0;
	for (const folder of deps.folders) {
		try {
			registered += await scanFolder(deps, folder);
		} catch (e) {
			failedFolders++;
			log("error", "folder scan failed", { code: (e as { code?: string }).code ?? "unexpected" });
		}
	}
	return { registered, failedFolders };
}

async function scanFolder(deps: ScanDeps, folder: string): Promise<number> {
	const { db, dbx } = deps;
	const now = (deps.now ?? Date.now)();
	const key = folder.toLowerCase();
	const previous = await getCursor(db, key);

	let listing: { entries: DbxEntry[]; cursor: string };
	let reset = false;
	if (previous === null) {
		listing = await drain(dbx, await dbx.listFolder(folder));
	} else {
		try {
			listing = await drain(dbx, await dbx.listContinue(previous));
		} catch (e) {
			if (!isCursorReset(e)) throw e;
			// Cursor invalidated by Dropbox: re-list. Re-registration is a no-op
			// for known versions, so no document is reprocessed or missed.
			log("warn", "dropbox cursor reset; re-listing folder");
			reset = true;
			listing = await drain(dbx, await dbx.listFolder(folder));
		}
	}

	const eligible = listing.entries.filter((e) => isTargetPdf(e, key));
	// 1. Durable registration first ...
	const created = await registerJobs(db, eligible, deps.mode, now);
	// 2. ... cursor second.
	if (reset) await replaceCursor(db, key, listing.cursor, now);
	else if (previous === null || (listing.entries.length > 0 && listing.cursor !== previous)) {
		await advanceCursor(db, key, previous, listing.cursor, now);
	}
	if (created > 0) log("info", "jobs registered", { created });
	return created;
}
