import type { IncomingMessage } from "node:http";

export async function readRawBody(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Webhook body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, totalBytes);
}
