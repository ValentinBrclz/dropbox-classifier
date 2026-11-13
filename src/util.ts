/**
 * Small shared helpers: logging (job ids only, never document data), error
 * taxonomy, backoff and hashing.
 */

/* ------------------------------ errors ------------------------------------ */

/**
 * Failure classes drive retry policy:
 * - transient: 429 / 5xx / network / timeout -> retry with backoff
 * - permanent: retrying cannot help (source gone, rev changed, 4xx) -> FAILED
 * - auth / config: operator action needed -> FAILED + alert, no blind retries
 */
export type ErrorCategory = "transient" | "permanent" | "auth" | "config";

/** Error carrying a category and a short machine code (never document data). */
export class ClassifierError extends Error {
	category: ErrorCategory;
	code: string;
	constructor(category: ErrorCategory, code: string, message?: string) {
		super(message ?? code);
		this.name = "ClassifierError";
		this.category = category;
		this.code = code;
	}
}

/** Category/code of any thrown value (unknown errors are treated as transient). */
export function describeError(err: unknown): { category: ErrorCategory; code: string } {
	if (err instanceof ClassifierError) return { category: err.category, code: err.code };
	return { category: "transient", code: "unexpected" };
}

/* ------------------------------ logging ----------------------------------- */

type Level = "error" | "warn" | "info";

/**
 * One structured log line. Callers pass job ids and codes only; the message
 * and fields must never contain file names, paths, person names or tokens.
 */
export function log(level: Level, message: string, data?: Record<string, unknown>): void {
	const line = data ? `[${level}] ${message} ${JSON.stringify(data)}` : `[${level}] ${message}`;
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}

/* ------------------------------ timing ------------------------------------ */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with full jitter.
 *
 * @param attempt - Zero-based attempt number.
 * @param baseMs - Delay for attempt 0 (before jitter).
 * @param capMs - Upper bound.
 */
export function backoffMs(attempt: number, baseMs = 500, capMs = 8000): number {
	return Math.round(Math.random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/** Parse `Retry-After` seconds, bounded to `capMs`. */
export function retryAfterMs(res: Response, capMs: number): number | undefined {
	const v = Number(res.headers.get("retry-after"));
	return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, capMs) : undefined;
}

/* ------------------------------ hashing ----------------------------------- */

/** Hex SHA-256 of a short string (identifiers only; never used on PDF bytes). */
export async function sha256Hex(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic job id for one Dropbox file version. */
export async function jobIdFor(fileId: string, rev: string): Promise<string> {
	return `j${(await sha256Hex(`${fileId}|${rev}`)).slice(0, 24)}`;
}

/** Workflow instance id for a job generation (<= 100 chars, charset-safe). */
export const instanceIdFor = (jobId: string, generation: number): string =>
	`${jobId}-g${generation}`;

/* ------------------------------ dates ------------------------------------- */

/** `YYYY-MM-DD` of an instant in Europe/Zurich. */
export function zurichDate(at: number): string {
	// en-CA yields ISO-style YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Zurich",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(at));
}
