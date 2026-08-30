import { drainResetTurnJobs } from "../src/reset/worker.js";

const SYNTHETIC_TURN_ID = "749c82f7-0ad8-4696-9be5-3a2b57df6594";

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
