export const FINAL_RESPONSE_GATE_VERSION = "hera-final-response-gate-1.1.0";
export const MAX_FINAL_RESPONSE_CORRECTIONS = 2;

interface QualityAssessment {
  passed: boolean;
}

interface VerificationResult {
  approved: boolean;
  correctedReply: string | null;
}

export interface FinalResponseGateResult<
  Quality extends QualityAssessment,
  Verification extends VerificationResult,
> {
  reply: string;
  draftQuality: Quality;
  quality: Quality;
  initialVerification: Verification;
  finalVerification: Verification;
  verificationAttempts: Verification[];
  correctionsApplied: number;
}

function requiredCorrection<Verification extends VerificationResult>(
  verification: Verification,
): string {
  if (!verification.correctedReply) {
    throw new Error("final_response_verifier_rejected_without_correction");
  }
  return verification.correctedReply;
}

export async function runFinalResponseGate<
  Quality extends QualityAssessment,
  Verification extends VerificationResult,
>(input: {
  draftReply: string;
  forcedReply?: string | null;
  cleanReply: (value: string) => string;
  assessQuality: (reply: string) => Quality;
  verify: (reply: string, quality: Quality) => Promise<Verification>;
}): Promise<FinalResponseGateResult<Quality, Verification>> {
  const draftReply = input.cleanReply(input.draftReply);
  const draftQuality = input.assessQuality(draftReply);
  const initialVerification = await input.verify(draftReply, draftQuality);
  const verificationAttempts = [initialVerification];
  const forcedReply = input.forcedReply == null
    ? null
    : input.cleanReply(input.forcedReply);

  let correctionsApplied = 0;
  let reply = forcedReply ?? (initialVerification.approved
    ? draftReply
    : input.cleanReply(requiredCorrection(initialVerification)));
  if (forcedReply === null && !initialVerification.approved) {
    correctionsApplied = 1;
  }
  let quality = input.assessQuality(reply);
  let finalVerification = initialVerification;

  const initialVerificationCoversReply =
    initialVerification.approved && reply === draftReply;
  if (!initialVerificationCoversReply) {
    finalVerification = await input.verify(reply, quality);
    verificationAttempts.push(finalVerification);
  }

  while (
    forcedReply === null &&
    !finalVerification.approved &&
    correctionsApplied < MAX_FINAL_RESPONSE_CORRECTIONS
  ) {
    reply = input.cleanReply(requiredCorrection(finalVerification));
    correctionsApplied += 1;
    quality = input.assessQuality(reply);
    finalVerification = await input.verify(reply, quality);
    verificationAttempts.push(finalVerification);
  }

  return {
    reply,
    draftQuality,
    quality,
    initialVerification,
    finalVerification,
    verificationAttempts,
    correctionsApplied,
  };
}
