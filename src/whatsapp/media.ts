import { gateway } from "@ai-sdk/gateway";
import { transcribe } from "ai";
import type { StoredMessage } from "../types.js";
import type { WhatsAppTransport } from "./client.js";

export interface ModelAttachment {
  type: "image" | "file";
  data: Uint8Array;
  mediaType: string;
  filename?: string;
}

export interface InterpretedInbound {
  text: string;
  attachment?: ModelAttachment;
  transcription?: {
    language?: string;
    durationInSeconds?: number;
  };
}

export async function interpretInboundMedia(
  message: StoredMessage,
  whatsapp: WhatsAppTransport,
  transcriptionModel: string,
): Promise<InterpretedInbound> {
  if (!message.media) return { text: message.text };

  if (message.kind === "audio") {
    const media = await whatsapp.downloadMedia(message.media.id, 20 * 1024 * 1024);
    const result = await transcribe({
      model: gateway.transcriptionModel(transcriptionModel),
      audio: media.data,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(60_000),
    });
    const transcript = result.text.trim();
    return {
      text: transcript
        ? `[Voice message transcript]\n${transcript}`
        : "[Voice message could not be transcribed. Ask the client to resend it as text.]",
      transcription: {
        language: result.language,
        durationInSeconds: result.durationInSeconds,
      },
    };
  }

  if (message.kind === "image") {
    const media = await whatsapp.downloadMedia(message.media.id, 10 * 1024 * 1024);
    return {
      text: message.text || "The client sent a hair photo for visual guidance.",
      attachment: {
        type: "image",
        data: media.data,
        mediaType: media.mimeType,
      },
    };
  }

  if (message.kind === "document" && message.media.mimeType === "application/pdf") {
    const media = await whatsapp.downloadMedia(message.media.id, 15 * 1024 * 1024);
    return {
      text: message.text || "The client sent a PDF document.",
      attachment: {
        type: "file",
        data: media.data,
        mediaType: media.mimeType,
        filename: message.media.filename || "whatsapp-document.pdf",
      },
    };
  }

  return { text: message.text };
}
