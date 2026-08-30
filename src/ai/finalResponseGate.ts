export const FINAL_RESPONSE_GATE_VERSION = "hera-final-response-gate-1.2.0";
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

function certifiedReply<Verification extends VerificationResult>(
  verification: Verification,
  submittedReply: string,
  cleanReply: (value: string) => string,
): string | null {
  if (!verification.approved) return null;
  return verification.correctedReply
    ? cleanReply(verification.correctedReply)
    : submittedReply;
}

function exactReplyVerification<Verification extends VerificationResult>(
  verification: Verification,
  exactReply: string,
  cleanReply: (value: string) => string,
): Verification {
  if (!verification.approved || !verification.correctedReply) {
    return verification;
  }
  const corrected = cleanReply(verification.correctedReply);
  if (corrected === exactReply) {
    return { ...verification, correctedReply: null };
  }
  // A forced deterministic safety reply must never be silently replaced by a
  // model-authored alternative. Treat a verifier that approves a different
  // text as not having approved the exact forced reply.
  return { ...verification, approved: false };
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

  if (forcedReply !== null) {
    const quality = input.assessQuality(forcedReply);
    const initialCoversForced =
      certifiedReply(initialVerification, draftReply, input.cleanReply) ===
      forcedReply;
    let finalVerification = initialCoversForced
      ? exactReplyVerification(
          initialVerification,
          forcedReply,
          input.cleanReply,
        )
      : await input.verify(forcedReply, quality);
    if (!initialCoversForced) verificationAttempts.push(finalVerification);
    finalVerification = exactReplyVerification(
      finalVerification,
      forcedReply,
      input.cleanReply,
    );
    return {
      reply: forcedReply,
      draftQuality,
      quality,
      initialVerification,
      finalVerification,
      verificationAttempts,
      correctionsApplied: 0,
    };
  }

  const initiallyCertified = certifiedReply(
    initialVerification,
    draftReply,
    input.cleanReply,
  );
  if (initiallyCertified !== null) {
    return {
      reply: initiallyCertified,
      draftQuality,
      quality: input.assessQuality(initiallyCertified),
      initialVerification,
      finalVerification: initialVerification,
      verificationAttempts,
      correctionsApplied: initiallyCertified === draftReply ? 0 : 1,
    };
  }

  let correctionsApplied = 1;
  let reply = input.cleanReply(requiredCorrection(initialVerification));
  let quality = input.assessQuality(reply);
  let finalVerification = await input.verify(reply, quality);
  verificationAttempts.push(finalVerification);

  while (true) {
    const certified = certifiedReply(
      finalVerification,
      reply,
      input.cleanReply,
    );
    if (certified !== null) {
      if (certified !== reply) {
        reply = certified;
        correctionsApplied += 1;
        quality = input.assessQuality(reply);
      }
      break;
    }
    if (correctionsApplied >= MAX_FINAL_RESPONSE_CORRECTIONS) break;

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
