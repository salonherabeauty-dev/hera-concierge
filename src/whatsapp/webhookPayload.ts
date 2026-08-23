import type {
  InboundMessage,
  JsonValue,
  MediaReference,
  MessageKind,
  ParsedWhatsAppWebhook,
  WhatsAppStatusEvent,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

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

function isoTimestamp(value: unknown): string | null {
  const seconds = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
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

function mediaReference(message: UnknownRecord, kind: MessageKind): MediaReference | undefined {
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

function messageText(message: UnknownRecord, kind: MessageKind): string {
  if (kind === "text") return text(record(message.text)?.body) ?? "";

  if (kind === "image" || kind === "video" || kind === "document") {
    return text(record(message[kind])?.caption) ?? "";
  }

  if (kind === "audio") return "[Voice message received]";
  if (kind === "sticker") return "[Sticker received]";

  if (kind === "button") {
    const button = record(message.button);
    return text(button?.text) ?? text(button?.payload) ?? "[Button response received]";
  }

  if (kind === "interactive") {
    const interactive = record(message.interactive);
    const buttonReply = record(interactive?.button_reply);
    const listReply = record(interactive?.list_reply);
    return (
      text(buttonReply?.title) ??
      text(listReply?.title) ??
      text(listReply?.description) ??
      "[Interactive response received]"
    );
  }

  if (kind === "location") {
    const location = record(message.location);
    const label = text(location?.name) ?? text(location?.address);
    return label ? `Shared location: ${label}` : "[Location shared]";
  }

  if (kind === "contacts") return "[Contact card received]";
  if (kind === "order") return "[Order details received]";
  if (kind === "reaction") return text(record(message.reaction)?.emoji) ?? "[Reaction received]";
  if (kind === "system") return text(record(message.system)?.body) ?? "[System message]";
  return "[Unsupported WhatsApp message received]";
}

function parseInbound(
  messageValue: unknown,
  contacts: unknown[],
  phoneNumberId: string | undefined,
  businessAccountId: string | undefined,
): InboundMessage | null {
  const message = record(messageValue);
  if (!message) return null;

  const providerMessageId = text(message.id);
  const fromWaId = text(message.from);
  const providerTimestamp = isoTimestamp(message.timestamp);
  if (!providerMessageId || !fromWaId || !providerTimestamp) return null;

  const contact = contacts
    .map(record)
    .find((candidate) => text(candidate?.wa_id) === fromWaId) ?? record(contacts[0]);
  const profileName = text(record(contact?.profile)?.name);
  const kind = normalizeKind(message.type);
  const contextMessageId = text(record(message.context)?.id);

  return {
    providerMessageId,
    fromWaId,
    profileName,
    phoneNumberId,
    businessAccountId,
    kind,
    text: messageText(message, kind),
    media: mediaReference(message, kind),
    contextMessageId,
    providerTimestamp,
    raw: asJson(message),
  };
}

function normalizeStatus(value: unknown): WhatsAppStatusEvent["status"] {
  switch (value) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
    case "deleted":
      return value;
    default:
      return "unknown";
  }
}

function parseStatus(value: unknown): WhatsAppStatusEvent | null {
  const status = record(value);
  if (!status) return null;
  const providerMessageId = text(status.id);
  const providerTimestamp = isoTimestamp(status.timestamp);
  if (!providerMessageId || !providerTimestamp) return null;

  return {
    providerMessageId,
    recipientWaId: text(status.recipient_id),
    status: normalizeStatus(status.status),
    providerTimestamp,
    errors: array(status.errors).map(asJson),
    raw: asJson(status),
  };
}

export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppWebhook {
  const root = record(payload);
  const inboundById = new Map<string, InboundMessage>();
  const statusesByKey = new Map<string, WhatsAppStatusEvent>();

  const parseValue = (
    valueInput: unknown,
    businessAccountId: string | undefined,
  ): void => {
    const value = record(valueInput);
    if (!value) return;

    const metadata = record(value.metadata);
    const phoneNumberId = text(metadata?.phone_number_id);
    const contacts = array(value.contacts);

    for (const messageValue of array(value.messages)) {
      const parsed = parseInbound(
        messageValue,
        contacts,
        phoneNumberId,
        businessAccountId,
      );
      if (parsed) inboundById.set(parsed.providerMessageId, parsed);
    }

    for (const statusValue of array(value.statuses)) {
      const parsed = parseStatus(statusValue);
      if (!parsed) continue;
      const key = `${parsed.providerMessageId}:${parsed.status}:${parsed.providerTimestamp}`;
      statusesByKey.set(key, parsed);
    }
  };

  for (const entryValue of array(root?.entry)) {
    const entry = record(entryValue);
    const businessAccountId = text(entry?.id);

    for (const changeValue of array(entry?.changes)) {
      const change = record(changeValue);
      const field = text(change?.field);
      // Meta and 360dialog deliver live inbound messages and delivery statuses
      // under the documented `messages` field. Coexistence history, app-state
      // sync and staff echoes use separate fields and must never enter the
      // ordinary client-message parser.
      if (field && field !== "messages") continue;
      parseValue(change?.value, businessAccountId);
    }
  }

  // Meta's dashboard "Send to server" tool posts a field sample directly as
  // { field: "messages", value: {...} }, without the live entry/changes envelope.
  // Accept that documented test shape while preserving the normal production path.
  if (text(root?.field) === "messages") parseValue(root?.value, undefined);

  return {
    inbound: [...inboundById.values()],
    statuses: [...statusesByKey.values()],
  };
}
