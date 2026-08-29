import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { RiskLevel } from "../types.js";
import type {
  BookingContextView,
  ConversationSummary,
  HandoffPriority,
} from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function risk(value: unknown): RiskLevel {
  if (value === "amber" || value === "red" || value === "black") return value;
  return "green";
}

function phoneEnding(value: unknown): string {
  return typeof value === "string" && value.length >= 4 ? value.slice(-4) : "—";
}

function preview(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function effectiveTime(row: Record<string, unknown>): number {
  const value = optionalString(row.provider_timestamp) ?? optionalString(row.created_at);
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function priorityRank(value: HandoffPriority): number {
  return { normal: 0, high: 1, urgent: 2, emergency: 3 }[value];
}

export class FrontDeskRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-front-desk/1.0" } },
    });
  }

  async listConversations(input: {
    mode?: "ai" | "management" | null;
    risk?: RiskLevel | null;
    search?: string | null;
    limit?: number;
  } = {}): Promise<ConversationSummary[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 250, 300));
    let query = this.database
      .from("ai_conversations")
      .select(
        "id,contact_id,status,operating_mode,current_risk,human_takeover_until,last_message_at",
      )
      .order("last_message_at", { ascending: false })
      .limit(limit);
    if (input.mode) query = query.eq("operating_mode", input.mode);
    if (input.risk) query = query.eq("current_risk", input.risk);

    const { data, error } = await query;
    if (error) throw new Error(`list front desk conversations: ${error.message}`);
    const conversationRows = array(data).map((value) => object(value, "conversation"));
    if (conversationRows.length === 0) return [];

    const conversationIds = conversationRows.map((row) =>
      string(row.id, "conversation id"),
    );
    const contactIds = [
      ...new Set(
        conversationRows.map((row) => string(row.contact_id, "contact id")),
      ),
    ];

    const [contactResult, messageResult, taskResult] = await Promise.all([
      this.database
        .from("ai_contacts")
        .select("id,profile_name,wa_id,preferred_language")
        .in("id", contactIds),
      this.database
        .from("ai_messages")
        .select(
          "id,conversation_id,direction,kind,text_body,provider_timestamp,created_at",
        )
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(Math.min(8000, Math.max(3000, conversationIds.length * 30))),
      this.database
        .from("ai_handoff_tasks")
        .select("conversation_id,status,priority")
        .in("conversation_id", conversationIds)
        .in("status", [
          "new",
          "assigned",
          "accepted",
          "waiting_client",
          "waiting_internal",
        ]),
    ]);

    if (contactResult.error) {
      throw new Error(`load front desk contacts: ${contactResult.error.message}`);
    }
    if (messageResult.error) {
      throw new Error(`load front desk messages: ${messageResult.error.message}`);
    }
    if (taskResult.error) {
      throw new Error(`load front desk tasks: ${taskResult.error.message}`);
    }

    const contacts = new Map(
      array(contactResult.data).map((value) => {
        const row = object(value, "contact");
        return [string(row.id, "contact id"), row] as const;
      }),
    );

    const latestMessages = new Map<string, Record<string, unknown>>();
    for (const value of array(messageResult.data)) {
      const row = object(value, "message");
      const conversationId = string(
        row.conversation_id,
        "message conversation id",
      );
      const current = latestMessages.get(conversationId);
      if (!current || effectiveTime(row) > effectiveTime(current)) {
        latestMessages.set(conversationId, row);
      }
    }

    const taskCounts = new Map<
      string,
      { count: number; highest: HandoffPriority | null }
    >();
    for (const value of array(taskResult.data)) {
      const row = object(value, "task");
      const conversationId = string(
        row.conversation_id,
        "task conversation id",
      );
      const current = taskCounts.get(conversationId) ?? {
        count: 0,
        highest: null,
      };
      const nextPriority = string(row.priority, "task priority") as HandoffPriority;
      current.count += 1;
      if (
        !current.highest ||
        priorityRank(nextPriority) > priorityRank(current.highest)
      ) {
        current.highest = nextPriority;
      }
      taskCounts.set(conversationId, current);
    }

    const search = input.search?.trim().toLowerCase() ?? "";
    return conversationRows
      .map((row): ConversationSummary => {
        const id = string(row.id, "conversation id");
        const contact = contacts.get(string(row.contact_id, "contact id"));
        if (!contact) throw new Error("Conversation contact was not returned");
        const latest = latestMessages.get(id);
        const tasks = taskCounts.get(id) ?? { count: 0, highest: null };
        const latestText = latest
          ? preview(latest.text_body) ||
            `[${optionalString(latest.kind) ?? "WhatsApp message"}]`
          : "";
        return {
          id,
          contactId: string(row.contact_id, "contact id"),
          clientDisplayName:
            optionalString(contact.profile_name) ??
            `Client •••• ${phoneEnding(contact.wa_id)}`,
          phoneEnding: phoneEnding(contact.wa_id),
          preferredLanguage: optionalString(contact.preferred_language),
          status: string(
            row.status,
            "conversation status",
          ) as ConversationSummary["status"],
          operatingMode:
            row.operating_mode === "management" ? "management" : "ai",
          currentRisk: risk(row.current_risk),
          humanTakeoverUntil: optionalString(row.human_takeover_until),
          lastMessageAt:
            optionalString(latest?.provider_timestamp) ??
            optionalString(latest?.created_at) ??
            string(row.last_message_at, "last_message_at"),
          lastMessagePreview: latestText,
          lastMessageDirection:
            latest?.direction === "inbound" || latest?.direction === "outbound"
              ? latest.direction
              : null,
          openTaskCount: tasks.count,
          highestPriority: tasks.highest,
        };
      })
      .filter((conversation) => {
        if (!search) return true;
        return (
          conversation.clientDisplayName.toLowerCase().includes(search) ||
          conversation.phoneEnding.includes(search) ||
          conversation.lastMessagePreview.toLowerCase().includes(search)
        );
      })
      .sort(
        (left, right) =>
          Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt),
      );
  }

  async getBookingContext(conversationId: string): Promise<BookingContextView[]> {
    const conversationResult = await this.database
      .from("ai_conversations")
      .select("contact_id")
      .eq("id", conversationId)
      .single();
    if (conversationResult.error || !conversationResult.data) {
      throw new Error("Conversation not found");
    }
    const conversation = object(conversationResult.data, "conversation");
    const contactResult = await this.database
      .from("ai_contacts")
      .select("wa_id")
      .eq("id", string(conversation.contact_id, "contact id"))
      .single();
    if (contactResult.error || !contactResult.data) {
      throw new Error("Conversation contact not found");
    }
    const contact = object(contactResult.data, "contact");
    const waId = string(contact.wa_id, "contact wa id");
    const { data, error } = await this.database.rpc(
      "ai_lookup_bookings_by_mobile",
      {
        p_mobile: `+${waId}`,
        p_limit: 20,
      },
    );
    if (error) throw new Error(`load recorded booking context: ${error.message}`);

    return array(data).map((value): BookingContextView => {
      const row = object(value, "booking context");
      return {
        id: string(row.id, "booking id"),
        clientName: string(row.client_name, "booking client name"),
        serviceName: string(row.service_name, "booking service name"),
        stylistName: optionalString(row.stylist_name),
        locationName: optionalString(row.location_name),
        appointmentAt: string(row.appointment_at, "booking appointment_at"),
        bookingStatus: string(row.booking_status, "booking status"),
        price:
          row.price === null || row.price === undefined
            ? null
            : Number(row.price),
        currency: string(row.currency, "booking currency"),
      };
    });
  }
}

export function createFrontDeskRepository(): FrontDeskRepository {
  return new FrontDeskRepository();
}
