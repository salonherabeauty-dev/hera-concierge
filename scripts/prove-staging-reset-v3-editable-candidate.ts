import { drainResetTurnJobs } from "../src/reset/worker.js";

const AUTHORITATIVE_STAGING_BRANCH = "feat/hera-ai-receptionist-foundation";
const SYNTHETIC_TURN_ID = "749c82f7-0ad8-4696-9be5-3a2b57df6594";

if (process.env.VERCEL_GIT_COMMIT_REF !== AUTHORITATIVE_STAGING_BRANCH) {
  console.log("RESET_V3_SYNTHETIC_PROOF_SKIPPED", JSON.stringify({
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    reason: "not_authoritative_staging_branch",
  }));
} else {
  const result = await drainResetTurnJobs({
    turnIds: [SYNTHETIC_TURN_ID],
    limit: 1,
    workerId: "reset-v3-approved-synthetic-connectivity-proof",
  });

  console.log("RESET_V3_SYNTHETIC_EDITABLE_CANDIDATE_PROOF", JSON.stringify(result));

  if (
    result.jobsClaimed !== 1 ||
    result.jobsReady !== 1 ||
    result.jobsFailed !== 0 ||
    result.jobsSuperseded !== 0 ||
    result.providerSendCalls !== 0 ||
    result.timelyWriteCalls !== 0
  ) {
    throw new Error("reset_v3_synthetic_editable_candidate_proof_failed");
  }
}
