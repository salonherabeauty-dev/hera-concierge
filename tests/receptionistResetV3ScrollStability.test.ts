import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL(
  "../public/command-centre/reset-scroll-stability.js",
  import.meta.url,
);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const resetUrl = new URL(
  "../public/command-centre/reset.html",
  import.meta.url,
);

test("Reset v3 preserves each transcript position when the workspace rerenders", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /const threadScrollMemory = new Map\(\)/);
  assert.match(source, /rememberThreadPosition/);
  assert.match(source, /remembered\.atBottom/);
  assert.match(source, /thread\.scrollTop = thread\.scrollHeight/);
  assert.match(source, /MutationObserver\(scheduleScrollRestore\)/);
  assert.match(source, /appRoot\.addEventListener\([\s\S]*"scroll"[\s\S]*true/);
  assert.match(source, /openingConversationId/);
  assert.match(source, /threadHasMessages/);

  assert.doesNotMatch(
    source,
    /fetch\(|request\(|setInterval|sendText|D360WhatsAppClient|Timely/i,
  );
});

test("both Reception Desk entries load the scroll fix after the Reset v3 workspace", async () => {
  const [index, reset] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(resetUrl, "utf8"),
  ]);

  assert.equal(index, reset);
  for (const html of [index, reset]) {
    assert.match(html, /reset-workspace\.js/);
    assert.match(html, /reset-scroll-stability\.js/);
    assert.ok(
      html.indexOf("reset-workspace.js") <
        html.indexOf("reset-scroll-stability.js"),
    );
    assert.doesNotMatch(
      html,
      /receptionist-workspace|receptionist-emergency-fix|receptionist-live-recovery/,
    );
  }
});
