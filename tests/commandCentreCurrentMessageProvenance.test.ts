import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../command-centre/src/app.ts", import.meta.url);
const repositoryUrl = new URL("../src/command-centre/repository.ts", import.meta.url);

test("the drawer binds candidates and quality evidence to the latest inbound message", async () => {
  const source = await readFile(appUrl, "utf8");
  assert.doesNotMatch(source, /const latestCandidate = detail\.candidates\[0\]/);
  assert.match(source, /candidate\.sourceMessageId === latestInbound\.id/);
  assert.match(source, /const traceSourceMessageId = latestInbound\?\.id \?\? null/);
  assert.match(source, /Previous AI candidate/);
  assert.match(source, /Not associated with the latest client message/);
  assert.match(source, /Final response quality for latest client turn/);
});

test("the Command Centre exposes processing state for each transcript message", async () => {
  const app = await readFile(appUrl, "utf8");
  const repository = await readFile(repositoryUrl, "utf8");
  assert.match(app, /detail\.jobs\.find\(\(job\) => job\.sourceMessageId === latestInbound\.id\)/);
  assert.match(app, /safely queued for retry/);
  assert.match(app, /safely superseded by a newer client turn/);
  assert.match(repository, /from\("ai_jobs"\)/);
  assert.match(repository, /source_message_id,status,attempts,max_attempts/);
  assert.match(repository, /jobs: ConversationJobView\[\]/);
});
