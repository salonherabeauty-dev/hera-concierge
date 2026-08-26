import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const expectedBranch = "feat/hera-ai-receptionist-foundation";
const expectedProjectRef = "zjnbheohgwfzkmbnjqjr";
const outputPath = "/tmp/hera-stage3r-calibration.jsonl";

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("Stage 3-R calibration requires Vercel Preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== expectedBranch) {
  throw new Error("Stage 3-R calibration requires the authoritative staging branch");
}
if ((process.env.WHATSAPP_SEND_MODE ?? "shadow") !== "shadow") {
  throw new Error("Stage 3-R calibration requires WhatsApp shadow mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("Stage 3-R calibration refuses live confirmation");
}
if (!process.env.SUPABASE_URL?.includes(expectedProjectRef)) {
  throw new Error("Stage 3-R calibration requires the isolated staging project");
}
if (!process.env.VERCEL_OIDC_TOKEN?.trim() && !process.env.AI_GATEWAY_API_KEY?.trim()) {
  throw new Error("Stage 3-R calibration requires authenticated AI Gateway access");
}

const started = performance.now();
await new Promise<void>((resolve, reject) => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/certification/stage3r/run.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STAGE3R_LIMIT: "20",
        STAGE3R_START_INDEX: "0",
        STAGE3R_OUTPUT_PATH: outputPath,
        STAGE3R_DRY_RUN: "false",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`Stage 3-R calibration exited with code ${code} signal ${signal}`));
  });
});

const lines = (await readFile(outputPath, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const cases = lines.filter((item) => item.event === "stage3r_case_completed");
const summary = lines.find((item) => item.event === "stage3r_bounded_batch_completed");
const start = lines.find((item) => item.event === "stage3r_run_started");

const providers = new Set<string>();
const judgeModels = new Set<string>();
const generatorModels = new Set<string>();
const verifierModels = new Set<string>();
const dimensionTotals: Record<string, number> = {};
let dimensionCount = 0;

for (const item of cases) {
  if (typeof item.responseModelId === "string") generatorModels.add(item.responseModelId);
  if (typeof item.firstVerifierModelId === "string") verifierModels.add(item.firstVerifierModelId);
  if (typeof item.finalVerifierModelId === "string") verifierModels.add(item.finalVerifierModelId);
  for (const judge of (item.judgeResults as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof judge.provider === "string") providers.add(judge.provider);
    if (typeof judge.modelId === "string") judgeModels.add(judge.modelId);
  }
  const assessment = item.assessment as Record<string, unknown> | undefined;
  const means = assessment?.dimensionMeans as Record<string, unknown> | undefined;
  if (means) {
    for (const [key, value] of Object.entries(means)) {
      if (typeof value === "number") dimensionTotals[key] = (dimensionTotals[key] ?? 0) + value;
    }
    dimensionCount += 1;
  }
}

const dimensionMeans = Object.fromEntries(
  Object.entries(dimensionTotals).map(([key, value]) => [
    key,
    dimensionCount > 0 ? Number((value / dimensionCount).toFixed(4)) : 0,
  ]),
);
const failures = cases
  .filter((item) => {
    const assessment = item.assessment as Record<string, unknown> | undefined;
    return assessment?.verdict !== "pass";
  })
  .map((item) => {
    const assessment = item.assessment as Record<string, unknown> | undefined;
    return {
      caseId: item.caseId,
      family: item.family,
      language: item.language,
      exactFinalResponse:
        typeof item.exactFinalResponse === "string"
          ? item.exactFinalResponse.slice(0, 900)
          : null,
      verdict: assessment?.verdict ?? "unknown",
      reasons: assessment?.reasons ?? [],
      criticalFlags: assessment?.criticalFlags ?? [],
      pipelineError: item.pipelineError ?? null,
    };
  });

console.log(
  "HERA_STAGE3R_CALIBRATION_SUMMARY",
  JSON.stringify({
    releaseCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    deploymentRef: process.env.VERCEL_URL ?? null,
    selectedCases: cases.length,
    estimatedMinimumModelCalls: start?.estimatedMinimumModelCalls ?? null,
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    pass: summary?.pass ?? null,
    fail: summary?.fail ?? null,
    needsReview: summary?.needsReview ?? null,
    generatorModels: [...generatorModels].sort(),
    verifierModels: [...verifierModels].sort(),
    judgeModels: [...judgeModels].sort(),
    judgeProviders: [...providers].sort(),
    meanDimensionScores: dimensionMeans,
    failureCount: failures.length,
    failures,
    whatsappProviderSendAvailable: false,
    databaseMutationAttempted: false,
    productionTouched: false,
  }),
);
