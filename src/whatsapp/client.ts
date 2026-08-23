export interface MetaWhatsAppClientConfig {
  graphApiVersion: string;
  accessToken: string;
  phoneNumberId: string;
}

export interface DownloadedMedia {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
  sha256?: string;
}

export interface SendTextResult {
  providerMessageId: string;
}

export interface WhatsAppTransport {
  sendText(toWaId: string, body: string): Promise<SendTextResult>;
  downloadMedia(mediaId: string, maxBytes?: number): Promise<DownloadedMedia>;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

/**
 * Only transient transport failures and retry-safe Meta responses should be
 * attempted again. Invalid payloads, permissions and other permanent 4xx
 * responses are dead-lettered immediately instead of generating retry storms.
 */
export function isRetryableWhatsAppError(error: unknown): boolean {
  if (error instanceof WhatsAppApiError) {
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  if (error instanceof TypeError) return true;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  return false;
}

function allowedMediaUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowedSuffixes = [
    ".facebook.com",
    ".fbcdn.net",
    ".fbsbx.com",
    ".whatsapp.net",
  ];
  if (
    url.protocol !== "https:" ||
    !allowedSuffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))
  ) {
    throw new Error("Meta returned an untrusted media URL");
  }
  return url;
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export class MetaWhatsAppClient implements WhatsAppTransport {
  constructor(
    private readonly config: MetaWhatsAppClientConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async sendText(toWaId: string, body: string): Promise<SendTextResult> {
    if (!/^[1-9][0-9]{7,14}$/.test(toWaId)) {
      throw new Error("Invalid destination WhatsApp id");
    }
    const cleanBody = body.trim();
    if (!cleanBody || cleanBody.length > 4000) {
      throw new Error("WhatsApp text must contain 1 to 4000 characters");
    }

    const url = `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
    const response = await this.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: toWaId,
        type: "text",
        text: { preview_url: false, body: cleanBody },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseJson(response);
    if (!response.ok) {
      throw new WhatsAppApiError("Meta rejected the outbound message", response.status, payload);
    }

    const messages =
      payload && typeof payload === "object" && "messages" in payload
        ? (payload as { messages?: unknown }).messages
        : undefined;
    const first = Array.isArray(messages) ? messages[0] : undefined;
    const providerMessageId =
      first && typeof first === "object" && "id" in first
        ? (first as { id?: unknown }).id
        : undefined;
    if (typeof providerMessageId !== "string" || !providerMessageId) {
      throw new WhatsAppApiError("Meta response did not include a message id", response.status, payload);
    }
    return { providerMessageId };
  }

  async downloadMedia(mediaId: string, maxBytes = 20 * 1024 * 1024): Promise<DownloadedMedia> {
    if (!mediaId || mediaId.length > 256) throw new Error("Invalid Meta media id");

    const metadataUrl = `https://graph.facebook.com/${this.config.graphApiVersion}/${encodeURIComponent(mediaId)}`;
    const metadataResponse = await this.request(metadataUrl, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const metadata = await parseJson(metadataResponse);
    if (!metadataResponse.ok || !metadata || typeof metadata !== "object") {
      throw new WhatsAppApiError("Unable to read Meta media metadata", metadataResponse.status, metadata);
    }

    const value = metadata as Record<string, unknown>;
    if (typeof value.url !== "string" || !value.url) {
      throw new WhatsAppApiError("Meta media metadata did not include a URL", metadataResponse.status, metadata);
    }
    if (typeof value.file_size === "number" && value.file_size > maxBytes) {
      throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);
    }

    const mediaUrl = allowedMediaUrl(value.url);
    const mediaResponse = await this.request(mediaUrl, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!mediaResponse.ok) {
      throw new WhatsAppApiError("Unable to download WhatsApp media", mediaResponse.status);
    }

    const declaredLength = Number(mediaResponse.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);
    }

    const data = new Uint8Array(await mediaResponse.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);

    return {
      data,
      mimeType:
        (typeof value.mime_type === "string" && value.mime_type) ||
        mediaResponse.headers.get("content-type") ||
        "application/octet-stream",
      sha256: typeof value.sha256 === "string" ? value.sha256 : undefined,
    };
  }
}
