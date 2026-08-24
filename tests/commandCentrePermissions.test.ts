import assert from "node:assert/strict";
import test from "node:test";
import {
  canControlScope,
  canHandleTask,
  hasCapability,
} from "../src/command-centre/permissions.js";

test("command centre roles expose only their approved capabilities", () => {
  assert.equal(hasCapability("owner", "manage_system"), true);
  assert.equal(hasCapability("managing_director", "manage_staff"), true);
  assert.equal(hasCapability("salon_manager", "assign_task"), true);
  assert.equal(hasCapability("receptionist", "assign_task"), false);
  assert.equal(hasCapability("finance_admin", "control_conversation"), false);
  assert.equal(hasCapability("auditor", "add_note"), false);
  assert.equal(hasCapability("auditor", "view_audit"), true);
});

test("specialist task ownership remains least privilege", () => {
  assert.equal(canHandleTask("receptionist", "booking_action"), true);
  assert.equal(canHandleTask("receptionist", "refund_finance"), false);
  assert.equal(canHandleTask("finance_admin", "refund_finance"), true);
  assert.equal(canHandleTask("finance_admin", "medical_safety"), false);
  assert.equal(canHandleTask("technical_lead", "technical_review"), true);
  assert.equal(canHandleTask("technical_lead", "privacy_legal"), false);
  assert.equal(canHandleTask("privacy_officer", "privacy_legal"), true);
  assert.equal(canHandleTask("salon_manager", "privacy_legal"), false);
  assert.equal(canHandleTask("owner", "security_review"), true);
});

test("conversation-control scope is explicit and auditors remain read-only", () => {
  assert.equal(canControlScope("owner", "emergency"), true);
  assert.equal(canControlScope("salon_manager", "full_takeover"), true);
  assert.equal(canControlScope("receptionist", "full_takeover"), true);
  assert.equal(canControlScope("receptionist", "emergency"), false);
  assert.equal(canControlScope("technical_lead", "emergency"), true);
  assert.equal(canControlScope("finance_admin", "full_takeover"), false);
  assert.equal(canControlScope("auditor", "task_only"), false);
});
