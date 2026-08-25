import { readFile, writeFile } from "node:fs/promises";

const workerPath = new URL("../src/worker.ts", import.meta.url);
const testPath = new URL("../tests/freshInboundPriority.test.ts", import.meta.url);

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Missing ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Ambiguous ${label}`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

let worker = await readFile(workerPath, "utf8");
worker = replaceOnce(
  worker,
  `  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);\n\n  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "before_operational_side_effects",\n    )\n  ) return;\n`,
  `  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "before_operational_side_effects",\n    )\n  ) return;\n\n  await runtime.repository.updateConversationRisk(\n    context.message.conversationId,\n    policy.risk,\n  );\n`,
  "risk update ordering",
);
await writeFile(workerPath, worker);

let testSource = await readFile(testPath, "utf8");
testSource = replaceOnce(
  testSource,
  `  const guard = source.indexOf('"before_operational_side_effects"');\n  const riskUpdate = source.indexOf("updateConversationRisk(context.message.conversationId");\n  assert.ok(guard >= 0 && riskUpdate > guard);\n`,
  `  const policyTraceStart = source.indexOf("const deliveryEligible");\n  const incidentStart = source.indexOf("if (policy.requiresIncident");\n  const operationalSegment = source.slice(policyTraceStart, incidentStart);\n  const guard = operationalSegment.indexOf('"before_operational_side_effects"');\n  const riskUpdate = operationalSegment.indexOf("updateConversationRisk(");\n  assert.ok(policyTraceStart >= 0 && incidentStart > policyTraceStart);\n  assert.ok(guard >= 0 && riskUpdate > guard);\n`,
  "risk ordering regression assertion",
);
await writeFile(testPath, testSource);
