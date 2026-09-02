import type { VercelRequest, VercelResponse } from "@vercel/node";

const LIVE_ORIGINS = new Set([
  "https://www.herabeauty.sg",
  "https://herabeauty.sg",
]);

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function websiteConciergeOrigin(
  request: VercelRequest,
): string | null {
  const raw = firstHeader(request.headers.origin);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (LIVE_ORIGINS.has(url.origin)) return url.origin;
    if (url.hostname.endsWith(".vercel.app")) return url.origin;
    return null;
  } catch {
    return null;
  }
}

export function applyWebsiteConciergeHeaders(
  request: VercelRequest,
  response: VercelResponse,
): string | null {
  const origin = websiteConciergeOrigin(request);
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Vary", "Origin");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Hera-Website-Session",
    );
    response.setHeader("Access-Control-Max-Age", "600");
  }
  return origin;
}

export function requireAllowedWebsiteOrigin(
  request: VercelRequest,
): void {
  const raw = firstHeader(request.headers.origin);
  if (!raw) return;
  if (!websiteConciergeOrigin(request)) {
    const error = new Error("Website concierge origin is not allowed.");
    error.name = "WebsiteConciergeOriginError";
    throw error;
  }
}

export function writeSse(
  response: VercelResponse,
  event: string,
  payload: unknown,
): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function safeWebsiteError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (name === "WebsiteConciergePreviewRequiredError") {
    return {
      status: 404,
      code: "website_concierge_preview_required",
      message: "Not found.",
    };
  }
  if (name === "WebsiteConciergeOriginError") {
    return {
      status: 403,
      code: "origin_not_allowed",
      message: "This website origin is not allowed.",
    };
  }
  if (name === "WebsiteConciergeAuthenticationError") {
    return {
      status: 401,
      code: "session_invalid",
      message: "This concierge session has expired. Please reopen the chat.",
    };
  }
  if (name === "WebsiteConciergeRateLimitError") {
    return {
      status: 429,
      code: "rate_limited",
      message: "Please wait a moment before sending another message.",
    };
  }
  return {
    status: 500,
    code: "website_concierge_unavailable",
    message:
      "I’m having a little difficulty responding just now. Please try once more, or contact the Hera team directly.",
  };
}
