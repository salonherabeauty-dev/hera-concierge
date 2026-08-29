import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const conversationsApiUrl = new URL(
  "../api/command-centre/conversations.ts",
  import.meta.url,
);
const workspaceUrl = new URL(
  "../src/command-centre/receptionistWorkspaceRepository.ts",
  import.meta.url,
);

test("a reviewable AI draft outranks human-handling presentation in the front desk inbox", async () => {
  const source = await readFile(conversationsApiUrl, "utf8");

  assert.match(source, /ReceptionistWorkspaceRepository/);
  assert.match(source, /workspace\.listQueue/);
  assert.match(source, /reviewableConversationIds/);
  assert.match(source, /exposeReviewableDraft/);
  assert.match(source, /operatingMode:\s*"ai"/);
  assert.match(source, /presentation normalization only/);
  assert.doesNotMatch(source, /setConversationMode|ai_cc_set_conversation_mode/);
});

test("the reviewable draft lookup remains the same human-approved queue used by Send to Client", async () => {
  const source = await readFile(workspaceUrl, "utf8");

  assert.match(source, /ai_cc_list_receptionist_queue/);
  assert.match(source, /canApprove:\s*row\.can_send === true/);
  assert.match(source, /approvalBlockReason/);
});
