import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isInboundHumanHandling,
  matchesInboxSearch,
  needsReplyInInbox,
} from "../public/command-centre/receptionist-inbox-policy.js";

const recoveryUrl = new URL(
  "../public/command-centre/receptionist-live-recovery.js",
  import.meta.url,
);
const workspaceUrl = new URL(
  "../public/command-centre/receptionist-workspace.js",
  import.meta.url,
);

const neoAfterNewMessage = {
  id: "conversation-neo",
  clientDisplayName: "Neo",
  phoneEnding: "2052",
  lastMessagePreview: "New client message",
  lastMessageDirection: "inbound",
  lastMessageAt: "2026-08-29T18:41:47.000Z",
  operatingMode: "management",
  currentRisk: "red",
  openTaskCount: 1,
};

test("a new inbound message remains reply-owed even during full human handling", () => {
  assert.equal(isInboundHumanHandling(neoAfterNewMessage), true);
  assert.equal(needsReplyInInbox(neoAfterNewMessage), true);
  assert.equal(matchesInboxSearch(neoAfterNewMessage, "neo"), true);
  assert.equal(matchesInboxSearch(neoAfterNewMessage, "2052"), true);
});

test("human handling does not force an already answered conversation into Needs reply", () => {
  const answered = {
    ...neoAfterNewMessage,
    lastMessageDirection: "outbound",
  };
  assert.equal(isInboundHumanHandling(answered), false);
  assert.equal(needsReplyInInbox(answered), false);
});

test("the recovery layer restores every missing reply-owed row without changing durable handling mode", async () => {
  const [recovery, workspace] = await Promise.all([
    readFile(recoveryUrl, "utf8"),
    readFile(workspaceUrl, "utf8"),
  ]);

  assert.match(workspace, /operatingMode === "management"[\s\S]*key: "held"/);
  assert.match(recovery, /repairMissingNeedsReplyRows/);
  assert.match(recovery, /filter\(needsReplyInInbox\)/);
  assert.match(recovery, /activeFilter\(\) !== "needs"/);
  assert.match(recovery, /data-recovered-needs-reply/);
  assert.match(recovery, /dataset\.action = "select-conversation"/);
  assert.match(recovery, /createChip\("Needs reply", "gold"\)/);
  assert.match(recovery, /createChip\("Human handling", "purple"\)/);
  assert.match(recovery, /matchesInboxSearch\(conversation, search\)/);
  assert.match(recovery, /sortVisibleInbox\(\)/);
  assert.match(recovery, /8_000/);
  assert.doesNotMatch(recovery, /sendText|D360WhatsAppClient|Timely/i);
});
