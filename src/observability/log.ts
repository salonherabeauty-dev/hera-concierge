export type OperationalLogLevel = "info" | "warn" | "error";
export type OperationalLogValue = string | number | boolean | null;

const SERVICE = "hera-ai-receptionist";

function bounded(value: string, max = 160): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, max);
}

export function safeErrorFields(
  error: unknown,
): Record<string, OperationalLogValue> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  const status = (error as Error & { status?: unknown }).status;
  return {
    errorName: bounded(error.name || "Error", 80),
    errorStatus: typeof status === "number" ? status : null,
  };
}

/**
 * Emits only explicitly supplied operational metadata. Callers must never pass
 * message bodies, WhatsApp ids, prompts, credentials, media or provider payloads.
 */
export function logOperationalEvent(
  level: OperationalLogLevel,
  event: string,
  fields: Record<string, OperationalLogValue> = {},
): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: SERVICE,
    level,
    event: bounded(event, 100),
    ...fields,
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
