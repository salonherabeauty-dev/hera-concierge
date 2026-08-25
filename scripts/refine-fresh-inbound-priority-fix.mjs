import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  if (!source.includes(before)) throw new Error(`Missing patch anchor in ${path}`);
  const updated = source.replace(before, after);
  if (updated === source) throw new Error(`No change made to ${path}`);
  await writeFile(path, updated);
}

await replaceOnce(
  "src/worker.ts",
  `  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);\n\n  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "before_operational_side_effects",\n    )\n  ) return;\n\n  if (policy.requiresIncident && policy.risk !== "green") {\n`,
  `  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "before_operational_side_effects",\n    )\n  ) return;\n\n  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);\n\n  if (policy.requiresIncident && policy.risk !== "green") {\n`,
);

await replaceOnce(
  "src/worker.ts",
  `      if (status === "dead") {\n        await queueDeadLetterFallback(runtime.repository, job).catch(() => undefined);\n      }\n`,
  `      if (status === "dead") {\n        if (await runtime.repository.isInboundSuperseded(job.sourceMessageId)) {\n          await runtime.repository.audit(\n            "dead_letter_fallback_suppressed",\n            "job",\n            job.id,\n            {\n              sourceMessageId: job.sourceMessageId,\n              reason: "newer_inbound_recorded_before_dead_letter_fallback",\n            },\n          );\n        } else {\n          await queueDeadLetterFallback(runtime.repository, job).catch(() => undefined);\n        }\n      }\n`,
);

await replaceOnce(
  "supabase/migrations/20260825000000_prioritize_fresh_inbound_jobs.sql",
  `  with requested as materialized (\n    select distinct requested_id as id, ordinal_position\n    from unnest(coalesce(p_job_ids, '{}'::uuid[])) with ordinality\n      as input(requested_id, ordinal_position)\n    where requested_id is not null\n  ),\n`,
  `  with requested as materialized (\n    select distinct on (requested_id)\n      requested_id as id,\n      ordinal_position\n    from unnest(coalesce(p_job_ids, '{}'::uuid[])) with ordinality\n      as input(requested_id, ordinal_position)\n    where requested_id is not null\n    order by requested_id, ordinal_position\n  ),\n`,
);

const testPath = "tests/freshInboundPriority.test.ts";
const testSource = await readFile(testPath, "utf8");
const addition = `\n\ntest("stale work is stopped before risk, incident, handoff or dead-letter fallback", async () => {\n  const source = await readFile(workerUrl, "utf8");\n  const sideEffectGuard = source.indexOf('"before_operational_side_effects"');\n  const riskUpdate = source.indexOf("updateConversationRisk(context.message.conversationId");\n  assert.ok(sideEffectGuard >= 0);\n  assert.ok(riskUpdate > sideEffectGuard);\n  assert.match(source, /dead_letter_fallback_suppressed/);\n  assert.match(source, /newer_inbound_recorded_before_dead_letter_fallback/);\n});\n`;
if (!testSource.includes("stale work is stopped before risk")) {
  await writeFile(testPath, testSource.trimEnd() + addition);
}
