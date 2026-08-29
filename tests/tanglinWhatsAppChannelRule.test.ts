import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";
import {
  BOOKING_OWNERSHIP_PRINCIPLE,
  BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE,
  TANGLIN_WHATSAPP_CHANNEL_RULE,
} from "../src/policy/bookingExperience.js";
import { HERA_TANGLIN_WHATSAPP_CHANNEL } from "../src/command-centre/receptionistWorkspaceBoundary.js";

const receptionistUrl = new URL("../src/ai/receptionist.ts", import.meta.url);
const migrationUrl = new URL(
  "../supabase/migrations/20260830000000_tanglin_only_whatsapp_channel.sql",
  import.meta.url,
);

test("the owner-approved channel is explicitly Tanglin Mall only", () => {
  assert.equal(HERA_TANGLIN_WHATSAPP_CHANNEL, "Tanglin Mall WhatsApp");
  assert.match(TANGLIN_WHATSAPP_CHANNEL_RULE, /exclusively.*Tanglin Mall/i);
  assert.match(TANGLIN_WHATSAPP_CHANNEL_RULE, /Never ask which outlet or atelier/i);
  assert.match(TANGLIN_WHATSAPP_CHANNEL_RULE, /never route.*Sentosa/i);
  assert.match(BOOKING_OWNERSHIP_PRINCIPLE, /verified channel context/i);
  assert.match(BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE, /Reject any reply or handoff/i);
  assert.match(BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE, /outlet.*Tanglin Mall/i);
});

test("both response generation and independent verification receive the channel rule", async () => {
  const source = await readFile(receptionistUrl, "utf8");
  assert.match(source, /BOOKING_OWNERSHIP_PRINCIPLE/);
  assert.match(source, /BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE/);
  assert.match(source, /RESPONSE_INSTRUCTIONS/);
  assert.match(source, /VERIFIER_INSTRUCTIONS/);
});

test("database migration records owner authority and blocks wrong-outlet human sends", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /owner-authority:tanglin-whatsapp-channel:v1/);
  assert.match(sql, /precedence_rank[\s\S]*100/i);
  assert.match(sql, /sentosaInboundExpected/);
  assert.match(sql, /ai_tanglin_whatsapp_reply_violation/);
  assert.match(sql, /ai_enforce_tanglin_human_approved_reply/);
  assert.match(sql, /human-receptionist:%/);
  assert.match(sql, /human-approved:%/);
  assert.match(sql, /Tanglin Mall WhatsApp reply violates channel scope/);
  assert.match(sql, /missing_facts[\s\S]*-[\s\S]*'outlet'/i);
});
