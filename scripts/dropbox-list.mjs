/**
 * Find the real Dropbox path to watch. Lists the direct children of a folder
 * with the same refresh token the Worker uses, and tells whether the account
 * has a team space (root namespace different from the home namespace).
 *
 * Usage: `node scripts/dropbox-list.mjs`, then answer the prompts. Enter an
 * empty path (or "/") to list the Dropbox root, then go down level by level.
 * Nothing is stored; credentials are only sent to Dropbox.
 */
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const key = (await rl.question("Dropbox app key: ")).trim();
const secret = (await rl.question("Dropbox app secret: ")).trim();
const refresh = (await rl.question("Refresh token: ")).trim();

const tokenRes = await fetch("https://api.dropbox.com/oauth2/token", {
	method: "POST",
	body: new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refresh,
		client_id: key,
		client_secret: secret,
	}),
});
if (!tokenRes.ok) {
	console.error(`Token refresh failed: HTTP ${tokenRes.status}`);
	process.exit(1);
}
const { access_token: token } = await tokenRes.json();
const call = (endpoint, body) =>
	fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const accountRes = await call("users/get_current_account");
if (accountRes.ok) {
	const account = await accountRes.json();
	const root = account.root_info ?? {};
	const teamSpace =
		root.root_namespace_id && root.root_namespace_id !== root.home_namespace_id;
	console.log(
		`\nAccount type: ${account.account_type?.[".tag"] ?? "?"}; team space: ${
			teamSpace ? "YES (root namespace differs from home: tell the developer)" : "no"
		}`,
	);
} else {
	console.log(`\nAccount info unavailable (HTTP ${accountRes.status}); continuing.`);
}

for (;;) {
	const path = (
		await rl.question('\nPath to list ("" or "/" = root, e.g. /Apps): ')
	).trim();
	const res = await call("files/list_folder", {
		path: path === "/" ? "" : path,
	});
	if (res.ok) {
		const { entries } = await res.json();
		for (const e of entries) {
			console.log(`  ${e[".tag"] === "folder" ? "[dir] " : "      "}${e.path_display}`);
		}
		if (!entries.length) console.log("  (empty)");
	} else {
		const e = await res.json().catch(() => ({}));
		console.log(`  -> HTTP ${res.status} ${e.error_summary ?? ""}`);
	}
	const again = (await rl.question("Another path? (y/N) ")).trim().toLowerCase();
	if (again !== "y") break;
}
rl.close();
