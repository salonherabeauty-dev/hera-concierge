import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { CommandCentreStaff } from "./types.js";

const PREVIEW_OWNER_EMAIL = "vercel-preview-owner@herabeauty.sg";
const PREVIEW_OWNER_DISPLAY_NAME = "Neo Chin Chuan";
const PREVIEW_OWNER_OUTLETS = ["Tanglin Mall", "Sentosa Quayside Isle"];

interface PreviewProfileRow {
  user_id: string;
  email: string;
  display_name: string;
  role: "owner";
  outlet_scope: string[] | null;
  status: "active" | "suspended" | "disabled";
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
    global: { headers: { "X-Client-Info": "hera-preview-owner/1.0" } },
  });
}

function mapProfile(row: PreviewProfileRow): CommandCentreStaff {
  if (row.status !== "active") {
    throw new Error("The protected Preview owner profile is not active");
  }
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: "owner",
    outletScope: Array.isArray(row.outlet_scope) ? row.outlet_scope : [],
    status: row.status,
    permissions:
      row.permissions && typeof row.permissions === "object"
        ? (row.permissions as CommandCentreStaff["permissions"])
        : {},
  };
}

async function existingProfile(): Promise<CommandCentreStaff | null> {
  const database = adminClient();
  const { data, error } = await database
    .from("ai_staff_profiles")
    .select(
      "user_id,email,display_name,role,outlet_scope,status,permissions",
    )
    .eq("email", PREVIEW_OWNER_EMAIL)
    .maybeSingle();

  if (error) throw new Error(`load protected Preview owner: ${error.message}`);
  if (!data) return null;
  if (data.role !== "owner") {
    throw new Error("The protected Preview owner has an invalid role");
  }
  return mapProfile(data as PreviewProfileRow);
}

async function findAuthUserId(): Promise<string | null> {
  const database = adminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await database.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw new Error(`list protected Preview identities: ${error.message}`);
    const match = data.users.find(
      (user) => user.email?.toLowerCase() === PREVIEW_OWNER_EMAIL,
    );
    if (match) return match.id;
    if (data.users.length < 100) break;
  }
  return null;
}

async function createAuthUserId(): Promise<string> {
  const database = adminClient();
  const password = randomBytes(48).toString("base64url");
  const { data, error } = await database.auth.admin.createUser({
    email: PREVIEW_OWNER_EMAIL,
    password,
    email_confirm: true,
    user_metadata: {
      display_name: PREVIEW_OWNER_DISPLAY_NAME,
      system_identity: "vercel_protected_preview_owner",
    },
  });

  if (!error && data.user) return data.user.id;

  const existing = await findAuthUserId();
  if (existing) return existing;
  throw new Error(`create protected Preview owner: ${error?.message ?? "unknown error"}`);
}

export async function ensurePreviewOwner(): Promise<CommandCentreStaff> {
  const current = await existingProfile();
  if (current) return current;

  const database = adminClient();
  const userId = (await findAuthUserId()) ?? (await createAuthUserId());
  const row: PreviewProfileRow = {
    user_id: userId,
    email: PREVIEW_OWNER_EMAIL,
    display_name: PREVIEW_OWNER_DISPLAY_NAME,
    role: "owner",
    outlet_scope: PREVIEW_OWNER_OUTLETS,
    status: "active",
    permissions: {
      previewOperator: true,
      accessBoundary: "vercel-authenticated-preview",
      canSendWhatsAppMessages: false,
    },
  };

  const { data, error } = await database
    .from("ai_staff_profiles")
    .upsert(row, { onConflict: "user_id" })
    .select(
      "user_id,email,display_name,role,outlet_scope,status,permissions",
    )
    .single();

  if (error || !data) {
    throw new Error(`provision protected Preview owner: ${error?.message ?? "no profile returned"}`);
  }
  return mapProfile(data as PreviewProfileRow);
}
