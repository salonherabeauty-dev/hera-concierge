import { gateway } from "@ai-sdk/gateway";
import { transcribe } from "ai";
import type { DownloadedMedia } from "../whatsapp/client.js";
import { WhatsAppApiError } from "../whatsapp/client.js";
import type { StoredMessage } from "../types.js";
import type { ResetMaterializedTurn } from "./types.js";

export interface ResetMediaDownloader {
  downloadMedia(mediaId: string, maxBytes?: number): Promise<DownloadedMedia>;
}

export interface ResetMediaDownloaderConfig {
  apiKey: string;
  baseUrl: string;
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function mediaDownloadUrl(value: string, baseUrl: string): URL {
  const original = new URL(value);
  const base = new URL(baseUrl);
  const allowedHosts = new Set([
    "lookaside.fbsbx.com",
    "waba-v2.360dialog.io",
    "waba-sandbox.360dialog.io",
  ]);
  if (
    original.protocol !== "https:" ||
    !allowedHosts.has(original.hostname.toLowerCase())
  ) {
    throw new Error("360dialog returned an untrusted media URL");
  }
  return new URL(`${original.pathname}${original.search}`, base);
}

export class D360ResetMediaDownloader implements ResetMediaDownloader {
  private readonly baseUrl: string;

  constructor(
    private readonly config: ResetMediaDownloaderConfig,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
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

    const mediaResponse = await this.request(
      mediaDownloadUrl(value.url, this.baseUrl),
      {
        headers: { "D360-API-KEY": this.config.apiKey },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      },
    );
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

function substantiveText(message: StoredMessage): string {
  const value = message.text.trim();
  if (
    message.kind === "unknown" &&
    /^\[unsupported (human )?whatsapp message (received|sent)\]$/i.test(value)
  ) {
    return "";
  }
  return value;
}

function fragmentLabel(message: StoredMessage, index: number): string {
  const kind = message.kind === "text" ? "message" : message.kind;
  return `[Client ${kind} ${index + 1}]`;
}

export async function materializeResetTurn(input: {
  fragments: StoredMessage[];
  downloader: ResetMediaDownloader;
  transcriptionModel: string;
}): Promise<ResetMaterializedTurn> {
  const textParts: string[] = [];
  const attachments: ResetMaterializedTurn["attachments"] = [];
  const warnings: string[] = [];
  let transcriptionCount = 0;

  for (const [index, message] of input.fragments.entries()) {
    const text = substantiveText(message);
    if (text) textParts.push(`${fragmentLabel(message, index)}\n${text}`);

    if (!message.media) {
      if (message.kind === "unknown") {
        textParts.push(
          `${fragmentLabel(message, index)}\nThe client sent an attachment or WhatsApp item whose contents could not be read. Do not ignore the other text in this client turn.`,
        );
        warnings.push(`Unsupported fragment: ${message.id}`);
      }
      continue;
    }

    try {
      if (message.kind === "audio") {
        const media = await input.downloader.downloadMedia(
          message.media.id,
          20 * 1024 * 1024,
        );
        const result = await transcribe({
          model: gateway.transcriptionModel(input.transcriptionModel),
          audio: media.data,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(60_000),
        });
        const transcript = result.text.trim();
        transcriptionCount += 1;
        if (transcript) {
          textParts.push(
            `${fragmentLabel(message, index)} transcript\n${transcript}`,
          );
        } else {
          warnings.push(`Voice message could not be transcribed: ${message.id}`);
          textParts.push(
            `${fragmentLabel(message, index)}\nA voice message was received but could not be transcribed.`,
          );
        }
        continue;
      }

      if (message.kind === "image") {
        const media = await input.downloader.downloadMedia(
          message.media.id,
          10 * 1024 * 1024,
        );
        attachments.push({
          type: "image",
          data: media.data,
          mediaType: media.mimeType,
          filename: message.media.filename,
        });
        if (!text) {
          textParts.push(
            `${fragmentLabel(message, index)}\nThe client included an image for visual review.`,
          );
        }
        continue;
      }

      if (
        message.kind === "document" &&
        message.media.mimeType === "application/pdf"
      ) {
        const media = await input.downloader.downloadMedia(
          message.media.id,
          15 * 1024 * 1024,
        );
        attachments.push({
          type: "file",
          data: media.data,
          mediaType: media.mimeType,
          filename: message.media.filename || "whatsapp-document.pdf",
        });
        if (!text) {
          textParts.push(
            `${fragmentLabel(message, index)}\nThe client included a PDF document for review.`,
          );
        }
        continue;
      }

      textParts.push(
        `${fragmentLabel(message, index)}\nThe client included a ${message.kind} attachment. Use its caption or surrounding messages; do not claim to have inspected content that is unavailable.`,
      );
      warnings.push(`Attachment not model-readable: ${message.id}`);
    } catch (error) {
      warnings.push(
        `Attachment preparation failed for ${message.id}: ${
          error instanceof Error ? error.name : "unknown_error"
        }`,
      );
      textParts.push(
        `${fragmentLabel(message, index)}\nAn attachment was received but could not be opened. Use the client's other messages and, only if necessary, ask them to resend this item.`,
      );
    }
  }

  const text = textParts.join("\n\n").trim();
  return {
    text:
      text ||
      "The client sent an attachment without readable text. Acknowledge it and ask only for the minimum information needed to continue.",
    attachments,
    warnings,
    transcriptionCount,
  };
}
