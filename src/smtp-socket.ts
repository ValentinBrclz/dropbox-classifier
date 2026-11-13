/**
 * Workers TCP socket adapter for {@link sendSmtp}. Kept separate because
 * `cloudflare:sockets` only exists inside workerd (unit tests inject a fake).
 * Port 25 is blocked on Workers; use 465 (implicit TLS).
 */

import { connect } from "cloudflare:sockets";
import type { SmtpConnection } from "./email.ts";

export async function socketConnect(host: string, port: number): Promise<SmtpConnection> {
	const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
	await socket.opened;
	return {
		readable: socket.readable,
		writable: socket.writable,
		close: () => socket.close(),
	};
}
