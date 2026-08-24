import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export function secureCommandCentreHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const section of header.split(";")) {
    const index = section.indexOf("=");
    if (index <= 0) continue;
    const key = section.slice(0, index).trim();
    const raw = section.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(raw));
    } catch {
      cookies.set(key, raw);
    }
  }
  return cookies;
}

export function serializeCookie(input: {
  name: string;
  value: string;
  maxAge: number;
  httpOnly: boolean;
}): string {
  const parts = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(input.maxAge))}`,
    "Secure",
    "SameSite=Strict",
  ];
  if (input.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

export function appendSetCookies(response: VercelResponse, cookies: string[]): void {
  const existing = response.getHeader("Set-Cookie");
  const values = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === "string"
      ? [existing]
      : [];
  response.setHeader("Set-Cookie", [...values, ...cookies]);
}

export function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function requestOriginMatchesHost(request: VercelRequest): boolean {
  const origin = firstHeader(request.headers.origin);
  if (!origin) return false;
  const host =
    firstHeader(request.headers["x-forwarded-host"]) ??
    firstHeader(request.headers.host);
  if (!host) return false;
  const proto = firstHeader(request.headers["x-forwarded-proto"]) ?? "https";
  try {
    const parsed = new URL(origin);
    return parsed.protocol === `${proto}:` && parsed.host === host;
  } catch {
    return false;
  }
}

export function requireSameOrigin(request: VercelRequest): void {
  if (!requestOriginMatchesHost(request)) {
    const error = new Error("Request origin is not permitted");
    error.name = "CommandCentreOriginError";
    throw error;
  }
}

export function parseJsonBody<T>(request: VercelRequest): T {
  const body = request.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body as T;
  if (typeof body !== "string" || body.length > 100_000) {
    throw new Error("Invalid JSON request body");
  }
  return JSON.parse(body) as T;
}

export function methodNotAllowed(
  response: VercelResponse,
  methods: string[],
): VercelResponse {
  response.setHeader("Allow", methods.join(", "));
  return response.status(405).json({ error: "Method not allowed" });
}

export function clientSafeError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (name === "CommandCentreAuthenticationError" || /authentication required/i.test(message)) {
    return { status: 401, code: "authentication_required", message: "Please sign in again." };
  }
  if (name === "CommandCentreValidationError") {
    return { status: 400, code: "request_invalid", message: "Check the information and try again." };
  }
  if (name === "CommandCentreOriginError") {
    return { status: 403, code: "origin_rejected", message: "Request was rejected." };
  }
  if (/csrf/i.test(message)) {
    return { status: 403, code: "csrf_rejected", message: "Your session must be refreshed." };
  }
  if (/version conflict/i.test(message)) {
    return {
      status: 409,
      code: "version_conflict",
      message: "This item changed. Refresh before trying again.",
    };
  }
  if (/not permitted|cannot assign|cannot transition|cannot control/i.test(message)) {
    return { status: 403, code: "forbidden", message: "You are not permitted to do that." };
  }
  if (/not found/i.test(message)) {
    return { status: 404, code: "not_found", message: "The requested item was not found." };
  }
  return { status: 400, code: "request_invalid", message: "The request could not be completed." };
}
