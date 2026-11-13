/** Dropbox webhook signature verification (HMAC-SHA256 over the raw body). */

/**
 * Verify the HMAC-SHA256 signature Dropbox sends in `X-Dropbox-Signature`.
 *
 * @param raw - Raw request body, exactly as received.
 * @param signatureHex - Hex-encoded signature from the header.
 * @param secret - Dropbox app secret used as HMAC key.
 * @returns `true` if the signature matches.
 */
export async function verifySignature(
  raw: string,
  signatureHex: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHex) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(raw));
  const expectedHex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expectedHex, signatureHex.toLowerCase());
}

/**
 * Constant-time string comparison (for equal-length inputs).
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns `true` if both strings are identical.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
