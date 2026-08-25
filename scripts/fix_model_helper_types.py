from pathlib import Path

path = Path("src/ai/receptionist.ts")
source = path.read_text(encoding="utf-8")
before = '''  for (let index = 0; index < models.length; index += 1) {
    const modelId = models[index];
    try {
      return await input.run(modelId, models.slice(index + 1));
    } catch (error) {
      lastError = error;
      const canRetry =
        index < models.length - 1 && retryableStructuredGenerationError(error);
      logOperationalEvent(canRetry ? "warn" : "error", "structured_generation_failed", {
        stage: input.stage,
        attemptedModel: modelId,
        fallbackModel: canRetry ? models[index + 1] : null,
        retrying: canRetry,
        ...safeErrorFields(error),
      });
      if (!canRetry) throw error;
    }
  }
'''
after = '''  for (let index = 0; index < models.length; index += 1) {
    const modelId = models[index];
    if (!modelId) continue;
    const nextModel = models[index + 1] ?? null;
    try {
      return await input.run(modelId, models.slice(index + 1));
    } catch (error) {
      lastError = error;
      const canRetry =
        nextModel !== null && retryableStructuredGenerationError(error);
      logOperationalEvent(canRetry ? "warn" : "error", "structured_generation_failed", {
        stage: input.stage,
        attemptedModel: modelId,
        fallbackModel: nextModel,
        retrying: canRetry,
        ...safeErrorFields(error),
      });
      if (!canRetry) throw error;
    }
  }
'''
if before not in source:
    raise RuntimeError("Structured fallback helper anchor was not found")
path.write_text(source.replace(before, after, 1), encoding="utf-8")
