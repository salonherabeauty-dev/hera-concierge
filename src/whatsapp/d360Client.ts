import {
  WhatsAppApiError,
  type DownloadedMedia,
  type SendTextResult,
  type WhatsAppTransport,
} from "./client.js";

export interface D360WhatsAppClientConfig {
  apiKey: string;
  baseUrl: string;
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function messageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("messages" in payload)) {
    return null;
  }
  const messages = (payload as { messages?: unknown }).messages;
  const first = Array.isArray(messages) ? messages[0] : undefined;
  if (!first || typeof first !== "object" || !("id" in first)) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function mediaDownloadUrl(value: string, baseUrl: string): URL {
  const original = new URL(value);
  const base = new URL(baseUrl);
  const originalHost = original.hostname.toLowerCase();
  const allowedOriginalHosts = new Set([
    "lookaside.fbsbx.com",
    "waba-v2.360dialog.io",
    "waba-sandbox.360dialog.io",
  ]);

  if (original.protocol !== "https:" || !allowedOriginalHosts.has(originalHost)) {
    throw new Error("360dialog returned an untrusted media URL");
  }

  // 360dialog requires the media path/query returned by Meta to be requested
  // through the 360dialog API host with the Number API Key.
  return new URL(`${original.pathname}${original.search}`, base);
}

export class D360WhatsAppClient implements WhatsAppTransport {
  private readonly baseUrl: string;

  constructor(
    private readonly config: D360WhatsAppClientConfig,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "D360-API-KEY": this.config.apiKey,
      "Content-Type": "application/json",
    };
  }

  async sendText(toWaId: string, body: string): Promise<SendTextResult> {
    if (!/^[1-9][0-9]{7,14}$/.test(toWaId)) {
      throw new Error("Invalid destination WhatsApp id");
    }
    const cleanBody = body.trim();
    if (!cleanBody || cleanBody.length > 4000) {
      throw new Error("WhatsApp text must contain 1 to 4000 characters");
    }

    const response = await this.request(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
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
      throw new WhatsAppApiError(
        "360dialog rejected the outbound message",
        response.status,
        payload,
      );
    }

    const providerMessageId = messageId(payload);
    if (!providerMessageId) {
      throw new WhatsAppApiError(
        "360dialog response did not include a message id",
        response.status,
        payload,
      );
    }
    return { providerMessageId };
  }

  async downloadMedia(
    mediaId: string,
    maxBytes = 20 * 1024 * 1024,
  ): Promise<DownloadedMedia> {
    if (!mediaId || mediaId.length > 256) {
      throw new Error("Invalid 360dialog media id");
    }

    const metadataResponse = await this.request(
      `${this.baseUrl}/${encodeURIComponent(mediaId)}`,
      {
        headers: { "D360-API-KEY": this.config.apiKey },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const metadata = await parseJson(metadataResponse);
    if (!metadataResponse.ok || !metadata || typeof metadata !== "object") {
      throw new WhatsAppApiError(
        "Unable to read 360dialog media metadata",
        metadataResponse.status,
        metadata,
      );
    }

    const value = metadata as Record<string, unknown>;
    if (typeof value.url !== "string" || !value.url) {
      throw new WhatsAppApiError(
        "360dialog media metadata did not include a URL",
        metadataResponse.status,
        metadata,
      );
    }
    if (typeof value.file_size === "number" && value.file_size > maxBytes) {
      throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);
    }

    const downloadUrl = mediaDownloadUrl(value.url, this.baseUrl);
    const mediaResponse = await this.request(downloadUrl, {
      headers: { "D360-API-KEY": this.config.apiKey },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!mediaResponse.ok) {
      throw new WhatsAppApiError(
        "Unable to download 360dialog media",
        mediaResponse.status,
      );
    }

    const declaredLength = Number(
      mediaResponse.headers.get("content-length") ?? "0",
    );
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);
    }

    const data = new Uint8Array(await mediaResponse.arrayBuffer());
    if (data.byteLength > maxBytes) {
      throw new Error(`WhatsApp media exceeds ${maxBytes} bytes`);
    }

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
