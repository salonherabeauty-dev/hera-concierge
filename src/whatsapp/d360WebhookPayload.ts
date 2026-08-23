import type {
  JsonValue,
  MediaReference,
  MessageKind,
  ParsedWhatsAppWebhook,
} from "../types.js";
import { parseWhatsAppWebhook } from "./webhookPayload.js";

type UnknownRecord = Record<string, unknown>;

export interface D360HumanEcho {
  providerMessageId: string;
  toWaId: string;
  fromWaId?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  kind: MessageKind;
  text: string;
  media?: MediaReference;
  contextMessageId?: string;
  providerTimestamp: string;
  raw: JsonValue;
}

export interface ParsedD360Webhook extends ParsedWhatsAppWebhook {
  humanEchoes: D360HumanEcho[];
  ignored: {
    history: number;
    appStateSync: number;
  };
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function isoTimestamp(value: unknown): string | null {
  const seconds = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizeWaId(value: unknown): string | null {
  const candidate = text(value)?.replace(/^\+/, "");
  return candidate && /^[1-9][0-9]{7,14}$/.test(candidate) ? candidate : null;
}

function normalizeKind(value: unknown): MessageKind {
  switch (value) {
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker":
    case "interactive":
    case "button":
    case "location":
    case "contacts":
    case "reaction":
    case "order":
    case "system":
      return value;
    default:
      return "unknown";
  }
}

function mediaReference(
  message: UnknownRecord,
  kind: MessageKind,
): MediaReference | undefined {
  if (!["image", "audio", "video", "document", "sticker"].includes(kind)) {
    return undefined;
  }
  const media = record(message[kind]);
  const id = text(media?.id);
  if (!media || !id) return undefined;
  return {
    id,
    mimeType: text(media.mime_type),
    sha256: text(media.sha256),
    caption: text(media.caption),
    filename: text(media.filename),
    voice: typeof media.voice === "boolean" ? media.voice : undefined,
  };
}

function echoText(message: UnknownRecord, kind: MessageKind): string {
  if (kind === "text") return text(record(message.text)?.body) ?? "";
  if (kind === "image" || kind === "video" || kind === "document") {
    return text(record(message[kind])?.caption) ?? "";
  }
  if (kind === "audio") return "[Human voice message sent]";
  if (kind === "sticker") return "[Human sticker sent]";
  if (kind === "button") {
    const button = record(message.button);
    return text(button?.text) ?? text(button?.payload) ?? "[Human button reply sent]";
  }
  if (kind === "interactive") {
    const interactive = record(message.interactive);
    const buttonReply = record(interactive?.button_reply);
    const listReply = record(interactive?.list_reply);
    return (
      text(buttonReply?.title) ??
      text(listReply?.title) ??
      text(listReply?.description) ??
      "[Human interactive message sent]"
    );
  }
  if (kind === "location") {
    const location = record(message.location);
    const label = text(location?.name) ?? text(location?.address);
    return label ? `Human shared location: ${label}` : "[Human location sent]";
  }
  if (kind === "contacts") return "[Human contact card sent]";
  if (kind === "order") return "[Human order message sent]";
  if (kind === "reaction") return text(record(message.reaction)?.emoji) ?? "[Human reaction sent]";
  if (kind === "system") return text(record(message.system)?.body) ?? "[Human system message]";
  return "[Unsupported human WhatsApp message sent]";
}

function parseEcho(
  value: unknown,
  phoneNumberId: string | undefined,
  businessAccountId: string | undefined,
): D360HumanEcho | null {
  const message = record(value);
  if (!message) return null;

  const providerMessageId = text(message.id);
  const toWaId = normalizeWaId(message.to);
  const providerTimestamp = isoTimestamp(message.timestamp);
  if (!providerMessageId || !toWaId || !providerTimestamp) return null;

  const kind = normalizeKind(message.type);
  return {
    providerMessageId,
    toWaId,
    fromWaId: normalizeWaId(message.from) ?? undefined,
    phoneNumberId,
    businessAccountId,
    kind,
    text: echoText(message, kind),
    media: mediaReference(message, kind),
    contextMessageId: text(record(message.context)?.id),
    providerTimestamp,
    raw: asJson(message),
  };
}

export function parseD360Webhook(payload: unknown): ParsedD360Webhook {
  const normal = parseWhatsAppWebhook(payload);
  const root = record(payload);
  const echoes = new Map<string, D360HumanEcho>();
  let history = text(root?.event) === "history" ? 1 : 0;
  let appStateSync = 0;

  for (const entryValue of array(root?.entry)) {
    const entry = record(entryValue);
    const businessAccountId = text(entry?.id);

    for (const changeValue of array(entry?.changes)) {
      const change = record(changeValue);
      const field = text(change?.field);
      const value = record(change?.value);
      if (field === "history") history += 1;
      if (field === "smb_app_state_sync") appStateSync += 1;
      if (field !== "smb_message_echoes" || !value) continue;

      const metadata = record(value.metadata);
      const phoneNumberId = text(metadata?.phone_number_id);
      for (const echoValue of array(value.message_echoes)) {
        const parsed = parseEcho(
          echoValue,
          phoneNumberId,
          businessAccountId,
        );
        if (parsed) echoes.set(parsed.providerMessageId, parsed);
      }
    }
  }

  return {
    ...normal,
    humanEchoes: [...echoes.values()],
    ignored: { history, appStateSync },
  };
}
