/** Folder settings and their fail-closed validation (no Workers-only imports: testable in Node). */

import { ClassifierError } from "./util.ts";
import { parseSourceFolders } from "./watcher.ts";

export interface Settings {
	mode: "live" | "dry_run";
	folders: string;
	archiveFolder: string;
}

/**
 * Fail closed on missing or unsafe folder settings. An empty `DROPBOX_SOURCE`
 * would otherwise mean the Dropbox root, and an empty `ARCHIVE_FOLDER` would
 * move originals to the root.
 *
 * @throws {ClassifierError} `config` errors with a short code (no values).
 */
export function assertConfigured(s: Settings): void {
	if (!s.folders.trim()) throw new ClassifierError("config", "no_source");
	let folders: string[];
	try {
		folders = parseSourceFolders(s.folders);
	} catch {
		throw new ClassifierError("config", "bad_source");
	}
	if (folders.some((f) => f === "")) throw new ClassifierError("config", "source_is_root");
	if (!s.archiveFolder.startsWith("/") || s.archiveFolder === "/") {
		throw new ClassifierError("config", "bad_archive_folder");
	}
}
