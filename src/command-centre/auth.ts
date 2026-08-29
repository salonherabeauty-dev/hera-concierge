import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig } from "../config.js";
import {
  COMMAND_CENTRE_ROLES,
  type CommandCentreRole,
  type CommandCentreSession,
  type CommandCentreStaff,
} from "./types.js";
import {
  appendSetCookies,
  firstHeader,
  parseCookies,
  safeEqual,
  serializeCookie,
} from "./http.js";
import { ensurePreviewOwner } from "./previewOwner.js";

export const COMMAND_CENTRE_ACCESS_COOKIE = "__Host-hera_cc_access";
export const COMMAND_CENTRE_REFRESH_COOKIE = "__Host-hera_cc_refresh";
export const COMMAND_CENTRE_CSRF_COOKIE = "__Host-hera_cc_csrf";

interface StaffProfileRow {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  outlet_scope: unknown;
  status: string;
  permissions: unknown;
}

function adminClient() {
  const database = getDatabaseConfig();
  return createClient(database.url, database.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "X-Client-Info": "hera-command-centre/1.0" } },
  });
}

export function isCommandCentrePasswordlessPreview(): boolean {
  const branch = process.env.VERCEL_GIT_COMMIT_REF ?? "";
  return (
    process.env.VERCEL_ENV === "preview" &&
    branch !== "main" &&
    process.env.WHATSAPP_SEND_MODE === "shadow" &&
    process.env.WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE"
  );
}

function isRole(value: string): value is CommandCentreRole {
  return COMMAND_CENTRE_ROLES.includes(value as CommandCentreRole);
}

function mapStaff(row: StaffProfileRow): CommandCentreStaff {
  if (!isRole(row.role)) throw new Error("Invalid command centre role");
  if (
    row.status !== "active" &&
    row.status !== "suspended" &&
    row.status !== "disabled"
  ) {
    throw new Error("Invalid command centre status");
  }
  const outletScope = Array.isArray(row.outlet_scope)
    ? row.outlet_scope.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    outletScope,
    status: row.status,
    permissions: (row.permissions ?? {}) as CommandCentreStaff["permissions"],
  };
}

function csrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function ensurePreviewCsrf(
  request: VercelRequest,
  response: VercelResponse,
): string {
  const cookies = parseCookies(firstHeader(request.headers.cookie));
  const existing = cookies.get(COMMAND_CENTRE_CSRF_COOKIE);
  if (existing) return existing;

  const csrf = csrfToken();
  appendSetCookies(response, [
    serializeCookie({
      name: COMMAND_CENTRE_CSRF_COOKIE,
      value: csrf,
      maxAge: 60 * 60 * 8,
      httpOnly: false,
    }),
  ]);
  return csrf;
}

export function setCommandCentreSession(
  response: VercelResponse,
  input: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    csrf?: string;
  },
): string {
  const csrf = input.csrf ?? csrfToken();
  appendSetCookies(response, [
    serializeCookie({
      name: COMMAND_CENTRE_ACCESS_COOKIE,
      value: input.accessToken,
      maxAge: Math.max(300, input.expiresIn),
      httpOnly: true,
    }),
    serializeCookie({
      name: COMMAND_CENTRE_REFRESH_COOKIE,
      value: input.refreshToken,
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
    }),
    serializeCookie({
      name: COMMAND_CENTRE_CSRF_COOKIE,
      value: csrf,
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: false,
    }),
  ]);
  return csrf;
}

export function clearCommandCentreSession(response: VercelResponse): void {
  appendSetCookies(response, [
    serializeCookie({
      name: COMMAND_CENTRE_ACCESS_COOKIE,
      value: "",
      maxAge: 0,
      httpOnly: true,
    }),
    serializeCookie({
      name: COMMAND_CENTRE_REFRESH_COOKIE,
      value: "",
      maxAge: 0,
      httpOnly: true,
    }),
    serializeCookie({
      name: COMMAND_CENTRE_CSRF_COOKIE,
      value: "",
      maxAge: 0,
      httpOnly: false,
    }),
  ]);
}

async function loadStaff(userId: string): Promise<CommandCentreStaff> {
  const database = adminClient();
  const { data, error } = await database
    .from("ai_staff_profiles")
    .select("user_id,email,display_name,role,outlet_scope,status,permissions")
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Command centre profile not found");
  const staff = mapStaff(data as StaffProfileRow);
  if (staff.status !== "active") {
    throw new Error("Command centre profile is not active");
  }

  void database
    .from("ai_staff_profiles")
    .update({ last_active_at: new Date().toISOString() })
    .eq("user_id", userId);
  return staff;
}

export async function authenticateCommandCentre(
  request: VercelRequest,
  response: VercelResponse,
): Promise<CommandCentreSession> {
  const preview = isCommandCentrePasswordlessPreview();
  const cookies = parseCookies(firstHeader(request.headers.cookie));
  const accessToken = cookies.get(COMMAND_CENTRE_ACCESS_COOKIE);
  const refreshToken = cookies.get(COMMAND_CENTRE_REFRESH_COOKIE);
  let csrf = cookies.get(COMMAND_CENTRE_CSRF_COOKIE) ?? csrfToken();
  const database = adminClient();

  // A valid Supabase staff session takes precedence over the Preview-owner
  // fallback. This preserves the private Vercel boundary while ensuring that
  // every receptionist approval is attributed to the actual named staff user.
  let userId: string | null = null;
  if (accessToken) {
    const { data, error } = await database.auth.getUser(accessToken);
    if (!error && data.user) userId = data.user.id;
  }

  if (!userId && refreshToken) {
    const { data, error } = await database.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (!error && data.session && data.user) {
      userId = data.user.id;
      csrf = setCommandCentreSession(response, {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        csrf,
      });
    }
  }

  if (userId) {
    if (!cookies.has(COMMAND_CENTRE_CSRF_COOKIE)) {
      appendSetCookies(response, [
        serializeCookie({
          name: COMMAND_CENTRE_CSRF_COOKIE,
          value: csrf,
          maxAge: 60 * 60 * 24 * 30,
          httpOnly: false,
        }),
      ]);
    }
    return { staff: await loadStaff(userId), csrfToken: csrf };
  }

  // Vercel Authentication remains the fallback identity boundary for isolated
  // non-main Previews. Neo keeps access for owner testing when no named staff
  // session is present.
  if (preview) {
    return {
      staff: await ensurePreviewOwner(),
      csrfToken: ensurePreviewCsrf(request, response),
    };
  }

  clearCommandCentreSession(response);
  const error = new Error("Command centre authentication required");
  error.name = "CommandCentreAuthenticationError";
  throw error;
}

export function requireCommandCentreCsrf(request: VercelRequest): void {
  const cookies = parseCookies(firstHeader(request.headers.cookie));
  const cookieToken = cookies.get(COMMAND_CENTRE_CSRF_COOKIE);
  const headerToken = firstHeader(request.headers["x-hera-csrf"]);
  if (!safeEqual(cookieToken, headerToken)) {
    throw new Error("Invalid command centre CSRF token");
  }
}

export async function signInCommandCentre(input: {
  email: string;
  password: string;
  response: VercelResponse;
}): Promise<CommandCentreSession> {
  const database = adminClient();
  const { data, error } = await database.auth.signInWithPassword({
    email: input.email.trim().toLowerCase(),
    password: input.password,
  });
  if (error || !data.session || !data.user) {
    throw new Error("Invalid email or password");
  }

  const staff = await loadStaff(data.user.id);
  const csrf = setCommandCentreSession(input.response, {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
  });
  return { staff, csrfToken: csrf };
}

export function commandCentreAdminClient() {
  return adminClient();
}
