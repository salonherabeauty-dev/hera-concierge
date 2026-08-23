import { timingSafeEqual } from "node:crypto";

function equal(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

export function verifyBasicAuthorization(
  header: string | undefined,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator < 1) return false;

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return equal(username, expectedUsername) && equal(password, expectedPassword);
}
