/**
 * Builds runtime dependencies from Worker bindings, secrets and variables.
 * Variables are read as strings; nothing here logs configuration values.
 */

import { Dropbox } from "./dropbox.ts";
import { type Notifier, sendSmtp } from "./email.ts";
import type { GeminiConfig } from "./gemini.ts";
import type { PipelineDeps } from "./steps.ts";
import { socketConnect } from "./smtp-socket.ts";

export interface Settings {
	mode: "live" | "dry_run";
	folders: string;
	archiveFolder: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v)).trim();

/** `MODE` must be explicitly "live" to touch Dropbox; anything else is dry-run. */
export function settings(env: Env): Settings {
	const e = env as unknown as Record<string, unknown>;
	return {
		mode: str(e.MODE) === "live" ? "live" : "dry_run",
		folders: str(e.DROPBOX_SOURCE),
		archiveFolder: str(e.ARCHIVE_FOLDER).replace(/\/+$/, ""),
	};
}

export function buildDropbox(env: Env): Dropbox {
	return new Dropbox({
		credentials: {
			appKey: env.DROPBOX_APP_KEY,
			appSecret: env.DROPBOX_APP_SECRET,
			refreshToken: env.DROPBOX_REFRESH_TOKEN,
		},
		kv: {
			get: (k) => env.STATE.get(k),
			put: (k, v) => env.STATE.put(k, v),
		},
	});
}

export function buildGemini(env: Env): GeminiConfig {
	const e = env as unknown as Record<string, unknown>;
	return {
		apiKey: str(e.GEMINI_API_KEY),
		primaryModel: str(e.GEMINI_MODEL_PRIMARY) || "gemini-3.8-flash",
		fallbackModel: str(e.GEMINI_MODEL_FALLBACK) || "gemini-3.5-flash-lite",
		serviceTier: str(e.GEMINI_SERVICE_TIER),
		timeoutMs: (Number(str(e.GEMINI_TIMEOUT_SECONDS)) || 600) * 1000,
	};
}

export function buildNotifier(env: Env): Notifier | null {
	const e = env as unknown as Record<string, unknown>;
	const host = str(e.SMTP_HOST);
	if (!host || !str(e.SMTP_USER) || !str(e.SMTP_PASSWORD)) return null;
	const cfg = {
		host,
		port: Number(str(e.SMTP_PORT)) || 465,
		user: str(e.SMTP_USER),
		password: str(e.SMTP_PASSWORD),
		from: str(e.SMTP_FROM) || str(e.SMTP_USER),
		to: str(e.NOTIFY_TO),
		connect: socketConnect,
	};
	if (!cfg.to) return null;
	return { send: (mail) => sendSmtp(cfg, mail) };
}

export function buildDeps(env: Env): PipelineDeps {
	return {
		db: env.DB,
		dbx: buildDropbox(env),
		gemini: buildGemini(env),
		notifier: buildNotifier(env),
		archiveFolder: settings(env).archiveFolder,
	};
}
