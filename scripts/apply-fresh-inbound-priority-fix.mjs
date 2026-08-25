import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  if (!source.includes(before)) {
    throw new Error(`Expected patch anchor was not found in ${path}`);
  }
  const updated = source.replace(before, after);
  if (updated === source) throw new Error(`Patch did not change ${path}`);
  await writeFile(path, updated);
}

await replaceOnce(
  "src/db/repository.ts",
  "  claimJobs(workerId: string, limit: number): Promise<ReceptionistJob[]>;\n",
  "  claimJobs(workerId: string, limit: number): Promise<ReceptionistJob[]>;\n  claimJobsByIds?(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]>;\n",
);

await replaceOnce(
  "src/db/repository.ts",
  `  async getJobContext(job: ReceptionistJob): Promise<JobContext> {\n`,
  `  async claimJobsByIds(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]> {\n    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);\n    if (uniqueJobIds.length === 0) return [];\n    const { data, error } = await this.database.rpc("ai_claim_jobs_by_ids", {\n      p_worker_id: workerId,\n      p_job_ids: uniqueJobIds,\n    });\n    const values = requireData(data, error, "claim targeted jobs") as unknown[];\n    return values.map((value) => {\n      const item = row(value);\n      return {\n        id: requiredString(item.id, "id"),\n        kind: "process_inbound",\n        sourceMessageId: requiredString(item.source_message_id, "source_message_id"),\n        payload: (item.payload ?? {}) as JsonValue,\n        attempts: Number(item.attempts),\n        maxAttempts: Number(item.max_attempts),\n      };\n    });\n  }\n\n  async getJobContext(job: ReceptionistJob): Promise<JobContext> {\n`,
);

await replaceOnce(
  "src/worker.ts",
  `export function isReplyWorthyMessage(kind: MessageKind): boolean {\n  return kind !== "reaction" && kind !== "system";\n}\n\nasync function processJob(runtime: WorkerRuntime, job: ReceptionistJob): Promise<void> {\n  const context = await runtime.repository.getJobContext(job);\n`,
  `export function isReplyWorthyMessage(kind: MessageKind): boolean {\n  return kind !== "reaction" && kind !== "system";\n}\n\nasync function completeSupersededJob(\n  runtime: WorkerRuntime,\n  job: ReceptionistJob,\n  stage: string,\n): Promise<boolean> {\n  if (!(await runtime.repository.isInboundSuperseded(job.sourceMessageId))) {\n    return false;\n  }\n  await runtime.repository.audit(\n    "out_of_order_inbound_suppressed",\n    "message",\n    job.sourceMessageId,\n    {\n      suppressionStage: stage,\n      jobId: job.id,\n      reason: "newer_inbound_recorded_before_side_effects",\n    },\n  );\n  await runtime.repository.completeJob(job.id);\n  return true;\n}\n\nasync function processJob(runtime: WorkerRuntime, job: ReceptionistJob): Promise<void> {\n  if (await completeSupersededJob(runtime, job, "before_context_load")) return;\n  const context = await runtime.repository.getJobContext(job);\n`,
);

await replaceOnce(
  "src/worker.ts",
  `  grounding = assessGrounding(interpreted.text, decision);\n`,
  `  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "after_primary_and_first_verifier",\n    )\n  ) return;\n\n  grounding = assessGrounding(interpreted.text, decision);\n`,
);

await replaceOnce(
  "src/worker.ts",
  `  const deliveryEligible = finalQuality.passed && finalVerification.approved;\n`,
  `  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "after_final_response_verifier",\n    )\n  ) return;\n\n  const deliveryEligible = finalQuality.passed && finalVerification.approved;\n`,
);

await replaceOnce(
  "src/worker.ts",
  `  if (policy.requiresIncident && policy.risk !== "green") {\n`,
  `  if (\n    await completeSupersededJob(\n      runtime,\n      job,\n      "before_operational_side_effects",\n    )\n  ) return;\n\n  if (policy.requiresIncident && policy.risk !== "green") {\n`,
);

await replaceOnce(
  "src/worker.ts",
  `  if (handoff.createTask) {\n`,
  `  if (handoff.createTask) {\n    if (\n      await completeSupersededJob(\n        runtime,\n        job,\n        "before_handoff_persistence",\n      )\n    ) return;\n`,
);

await replaceOnce(
  "src/worker.ts",
  `  if (deliveryEligible && (policy.canAutoSend || handoff.createTask)) {\n`,
  `  if (deliveryEligible && (policy.canAutoSend || handoff.createTask)) {\n    if (\n      await completeSupersededJob(\n        runtime,\n        job,\n        "before_client_candidate_persistence",\n      )\n    ) return;\n`,
);

const oldDrain = `export async function drainReceptionist(\n  runtime: WorkerRuntime,\n  maxJobs = 8,\n): Promise<DrainSummary> {\n  const workerId = \`vercel:\${randomUUID()}\`;\n  const jobs = await runtime.repository.claimJobs(workerId, maxJobs);\n  let jobsCompleted = 0;\n  let jobsRetried = 0;\n\n  for (const job of jobs) {\n    try {\n      await processJob(runtime, job);\n      jobsCompleted += 1;\n    } catch (error) {\n      const status = await runtime.repository.retryJob(job, error);\n      jobsRetried += 1;\n      logOperationalEvent(status === "retry" ? "warn" : "error", "job_processing_failed", {\n        jobId: job.id,\n        attempt: job.attempts,\n        disposition: status,\n        ...safeErrorFields(error),\n      });\n      if (status === "dead") {\n        await queueDeadLetterFallback(runtime.repository, job).catch(() => undefined);\n      }\n    }\n  }\n\n  const outbox = await drainOutbox({\n    repository: runtime.repository,\n    whatsapp: runtime.whatsapp,\n    sendMode: runtime.sendMode,\n    workerId,\n    authorizeOutbound: runtime.authorizeOutbound,\n  });\n  return {\n    jobsClaimed: jobs.length,\n    jobsCompleted,\n    jobsRetried,\n    ...outbox,\n  };\n}\n`;

const newDrain = `async function drainClaimedReceptionistJobs(\n  runtime: WorkerRuntime,\n  workerId: string,\n  jobs: ReceptionistJob[],\n): Promise<DrainSummary> {\n  let jobsCompleted = 0;\n  let jobsRetried = 0;\n\n  for (const job of jobs) {\n    try {\n      await processJob(runtime, job);\n      jobsCompleted += 1;\n    } catch (error) {\n      const status = await runtime.repository.retryJob(job, error);\n      jobsRetried += 1;\n      logOperationalEvent(status === "retry" ? "warn" : "error", "job_processing_failed", {\n        jobId: job.id,\n        attempt: job.attempts,\n        disposition: status,\n        ...safeErrorFields(error),\n      });\n      if (status === "dead") {\n        await queueDeadLetterFallback(runtime.repository, job).catch(() => undefined);\n      }\n    }\n  }\n\n  const outbox = await drainOutbox({\n    repository: runtime.repository,\n    whatsapp: runtime.whatsapp,\n    sendMode: runtime.sendMode,\n    workerId,\n    authorizeOutbound: runtime.authorizeOutbound,\n  });\n  return {\n    jobsClaimed: jobs.length,\n    jobsCompleted,\n    jobsRetried,\n    ...outbox,\n  };\n}\n\nexport async function drainReceptionist(\n  runtime: WorkerRuntime,\n  maxJobs = 8,\n): Promise<DrainSummary> {\n  const workerId = \`vercel:\${randomUUID()}\`;\n  const jobs = await runtime.repository.claimJobs(workerId, maxJobs);\n  return drainClaimedReceptionistJobs(runtime, workerId, jobs);\n}\n\nexport async function drainReceptionistForJobs(\n  runtime: WorkerRuntime,\n  jobIds: string[],\n  maxJobs = 8,\n): Promise<DrainSummary> {\n  const requestedJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);\n  if (requestedJobIds.length === 0) {\n    return drainReceptionist(runtime, maxJobs);\n  }\n  if (!runtime.repository.claimJobsByIds) {\n    throw new Error("Targeted job claiming is unavailable");\n  }\n\n  const workerId = \`vercel:targeted:\${randomUUID()}\`;\n  const capacity = Math.max(\n    requestedJobIds.length,\n    Math.max(1, Math.min(maxJobs, 25)),\n  );\n  const targetedJobs = await runtime.repository.claimJobsByIds(\n    workerId,\n    requestedJobIds,\n  );\n  const targetedIds = new Set(targetedJobs.map((job) => job.id));\n  const remainingCapacity = Math.max(0, capacity - targetedJobs.length);\n  const backlogJobs = remainingCapacity > 0\n    ? await runtime.repository.claimJobs(workerId, remainingCapacity)\n    : [];\n  const jobs = [\n    ...targetedJobs,\n    ...backlogJobs.filter((job) => !targetedIds.has(job.id)),\n  ];\n\n  return drainClaimedReceptionistJobs(runtime, workerId, jobs);\n}\n`;
await replaceOnce("src/worker.ts", oldDrain, newDrain);

for (const path of ["api/whatsapp/360dialog.ts", "api/whatsapp/webhook.ts"]) {
  await replaceOnce(
    path,
    `import { createProductionRuntime, drainReceptionist } from "../../src/worker.js";`,
    `import {\n  createProductionRuntime,\n  drainReceptionistForJobs,\n} from "../../src/worker.js";`,
  );
}

await replaceOnce(
  "api/whatsapp/360dialog.ts",
  `    let inboundInserted = 0;\n    let wakeableJobs = 0;\n    for (const message of parsed.inbound) {\n      const result = await repository.ingestInbound(message);\n      if (result.inserted) inboundInserted += 1;\n      if (result.jobId) wakeableJobs += 1;\n    }\n`,
  `    let inboundInserted = 0;\n    const wakeableJobIds: string[] = [];\n    for (const message of parsed.inbound) {\n      const result = await repository.ingestInbound(message);\n      if (result.inserted) inboundInserted += 1;\n      if (result.jobId) wakeableJobIds.push(result.jobId);\n    }\n`,
);

await replaceOnce(
  "api/whatsapp/360dialog.ts",
  `    if (wakeableJobs > 0) {\n      const drainLimit = Math.min(Math.max(wakeableJobs, 1), 8);\n      waitUntil(\n        Promise.resolve()\n          .then(() => drainReceptionist(createProductionRuntime(), drainLimit))\n`,
  `    if (wakeableJobIds.length > 0) {\n      const drainLimit = Math.min(Math.max(wakeableJobIds.length, 1), 8);\n      waitUntil(\n        Promise.resolve()\n          .then(() =>\n            drainReceptionistForJobs(\n              createProductionRuntime(),\n              wakeableJobIds,\n              drainLimit,\n            ),\n          )\n`,
);

await replaceOnce(
  "api/whatsapp/360dialog.ts",
  `      inboundInserted,\n      statusCount: parsed.statuses.length,\n`,
  `      inboundInserted,\n      targetedJobCount: wakeableJobIds.length,\n      statusCount: parsed.statuses.length,\n`,
);

await replaceOnce(
  "api/whatsapp/webhook.ts",
  `  let inserted = 0;\n  for (const message of parsed.inbound) {\n    const result = await repository.ingestInbound(message);\n    if (result.inserted) inserted += 1;\n  }\n`,
  `  let inserted = 0;\n  const wakeableJobIds: string[] = [];\n  for (const message of parsed.inbound) {\n    const result = await repository.ingestInbound(message);\n    if (result.inserted) inserted += 1;\n    if (result.jobId) wakeableJobIds.push(result.jobId);\n  }\n`,
);

await replaceOnce(
  "api/whatsapp/webhook.ts",
  `  if (parsed.inbound.length > 0) {\n    const drainLimit = Math.min(Math.max(inserted, parsed.inbound.length), 8);\n    waitUntil(\n      Promise.resolve()\n        .then(() => drainReceptionist(createProductionRuntime(), drainLimit))\n`,
  `  if (wakeableJobIds.length > 0) {\n    const drainLimit = Math.min(Math.max(wakeableJobIds.length, 1), 8);\n    waitUntil(\n      Promise.resolve()\n        .then(() =>\n          drainReceptionistForJobs(\n            createProductionRuntime(),\n            wakeableJobIds,\n            drainLimit,\n          ),\n        )\n`,
);

await replaceOnce(
  "api/whatsapp/webhook.ts",
  `    insertedCount: inserted,\n    statusCount: parsed.statuses.length,\n`,
  `    insertedCount: inserted,\n    targetedJobCount: wakeableJobIds.length,\n    statusCount: parsed.statuses.length,\n`,
);

const migration = `begin;\n\ncreate or replace function public.ai_claim_jobs_by_ids(\n  p_worker_id text,\n  p_job_ids uuid[]\n) returns setof public.ai_jobs\nlanguage sql\nsecurity definer\nset search_path = ''\nas $$\n  with requested as materialized (\n    select distinct requested_id as id, ordinal_position\n    from unnest(coalesce(p_job_ids, '{}'::uuid[])) with ordinality\n      as input(requested_id, ordinal_position)\n    where requested_id is not null\n  ),\n  suppressible as materialized (\n    select job.id, job.source_message_id\n    from public.ai_jobs as job\n    join requested on requested.id = job.id\n    where (\n      (job.status in ('pending', 'retry') and job.available_at <= now())\n      or (job.status = 'processing' and job.locked_at < now() - interval '5 minutes')\n    )\n    and public.ai_is_inbound_superseded(job.source_message_id)\n    for update of job skip locked\n  ),\n  suppressed as (\n    update public.ai_jobs as job\n    set status = 'completed',\n        completed_at = now(),\n        locked_at = null,\n        locked_by = null,\n        last_error = 'superseded_by_newer_inbound',\n        updated_at = now()\n    from suppressible\n    where job.id = suppressible.id\n    returning job.id, job.source_message_id\n  ),\n  audit as (\n    insert into public.ai_audit_log (\n      actor_type, actor_id, event_type, target_type, target_id, details\n    )\n    select\n      'system',\n      'hera_receptionist',\n      'out_of_order_inbound_suppressed',\n      'message',\n      suppressed.source_message_id::text,\n      jsonb_build_object(\n        'suppressionStage', 'targeted_job_claim',\n        'jobId', suppressed.id,\n        'reason', 'newer_inbound_recorded_before_targeted_processing'\n      )\n    from suppressed\n    returning id\n  ),\n  selected as (\n    select job.id\n    from public.ai_jobs as job\n    join requested on requested.id = job.id\n    cross join (select count(*) as audit_count from audit) as audit_barrier\n    where (\n      (job.status in ('pending', 'retry') and job.available_at <= now())\n      or (job.status = 'processing' and job.locked_at < now() - interval '5 minutes')\n    )\n    and audit_barrier.audit_count >= 0\n    and not exists (select 1 from suppressible where suppressible.id = job.id)\n    and not public.ai_is_inbound_superseded(job.source_message_id)\n    order by requested.ordinal_position, job.created_at\n    for update of job skip locked\n    limit 25\n  )\n  update public.ai_jobs as job\n  set status = 'processing',\n      attempts = job.attempts + 1,\n      locked_at = now(),\n      locked_by = nullif(trim(p_worker_id), ''),\n      updated_at = now()\n  from selected\n  where job.id = selected.id\n  returning job.*;\n$$;\n\nrevoke all on function public.ai_claim_jobs_by_ids(text, uuid[])\n  from public, anon, authenticated;\ngrant execute on function public.ai_claim_jobs_by_ids(text, uuid[])\n  to service_role;\n\ncommit;\n`;
await writeFile(
  "supabase/migrations/20260825000000_prioritize_fresh_inbound_jobs.sql",
  migration,
);

const tests = `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\nimport { parse } from "libpg-query";\n\nconst migrationUrl = new URL(\n  "../supabase/migrations/20260825000000_prioritize_fresh_inbound_jobs.sql",\n  import.meta.url,\n);\nconst repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);\nconst workerUrl = new URL("../src/worker.ts", import.meta.url);\nconst d360Url = new URL("../api/whatsapp/360dialog.ts", import.meta.url);\nconst metaUrl = new URL("../api/whatsapp/webhook.ts", import.meta.url);\n\ntest("PostgreSQL accepts the targeted fresh-job claim migration", async () => {\n  const sql = await readFile(migrationUrl, "utf8");\n  const result = await parse(sql);\n  assert.ok(result.stmts.length > 0);\n  assert.match(sql, /create or replace function public\\.ai_claim_jobs_by_ids/);\n  assert.match(sql, /join requested on requested\\.id = job\\.id/);\n  assert.match(sql, /for update of job skip locked/);\n  assert.match(sql, /superseded_by_newer_inbound/);\n});\n\ntest("the repository can atomically claim exact webhook-created jobs", async () => {\n  const source = await readFile(repositoryUrl, "utf8");\n  assert.match(source, /claimJobsByIds\\?/);\n  assert.match(source, /rpc\\("ai_claim_jobs_by_ids"/);\n  assert.match(source, /p_job_ids: uniqueJobIds/);\n});\n\ntest("both WhatsApp webhook adapters prioritize the jobs they just created", async () => {\n  for (const url of [d360Url, metaUrl]) {\n    const source = await readFile(url, "utf8");\n    assert.match(source, /const wakeableJobIds: string\\[\\] = \\[\\]/);\n    assert.match(source, /wakeableJobIds\\.push\\(result\\.jobId\\)/);\n    assert.match(source, /drainReceptionistForJobs/);\n  }\n});\n\ntest("the worker processes targeted jobs before unrelated backlog", async () => {\n  const source = await readFile(workerUrl, "utf8");\n  assert.match(source, /export async function drainReceptionistForJobs/);\n  assert.match(source, /const targetedJobs = await runtime\\.repository\\.claimJobsByIds/);\n  assert.match(source, /const backlogJobs = remainingCapacity > 0/);\n  assert.match(source, /\\.\\.\\.targetedJobs,[\\s\\S]*\\.\\.\\.backlogJobs\\.filter/);\n});\n\ntest("supersession is rechecked before every irreversible client-facing side effect", async () => {\n  const source = await readFile(workerUrl, "utf8");\n  for (const stage of [\n    "before_context_load",\n    "after_primary_and_first_verifier",\n    "after_final_response_verifier",\n    "before_operational_side_effects",\n    "before_handoff_persistence",\n    "before_client_candidate_persistence",\n  ]) {\n    assert.match(source, new RegExp(stage));\n  }\n  assert.match(source, /newer_inbound_recorded_before_side_effects/);\n});\n`;
await writeFile("tests/freshInboundPriority.test.ts", tests);
