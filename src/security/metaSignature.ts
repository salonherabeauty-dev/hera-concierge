import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export function createMetaSignature(rawBody: Uint8Array, appSecret: string): string {
  const digest = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyMetaSignature(
  rawBody: Uint8Array,
  signatureHeader: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof signatureHeader !== "string") return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const suppliedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;

  const supplied = Buffer.from(suppliedHex, "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
