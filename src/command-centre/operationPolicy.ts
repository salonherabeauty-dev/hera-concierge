import type { JsonValue } from "../types.js";
import type {
  HandoffScope,
  HandoffStatus,
  HandoffTaskType,
} from "./types.js";

export const BOOKING_OUTCOMES = [
  "appointment_confirmed",
  "alternative_offered",
  "more_information_required",
  "waiting_internal",
  "stylist_unavailable",
  "client_declined",
  "test_completed",
] as const;

export type BookingOutcome = (typeof BOOKING_OUTCOMES)[number];

export interface TaskControlRecord {
  id: string;
  conversationId: string;
  taskType: HandoffTaskType;
  scope: HandoffScope;
  status: HandoffStatus;
  ownerUserId: string | null;
  version: number;
}

function record(value: JsonValue | unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bookingOutcome(value: unknown): BookingOutcome | null {
  const candidate = clean(value);
  return BOOKING_OUTCOMES.includes(candidate as BookingOutcome)
    ? (candidate as BookingOutcome)
    : null;
}

export function validateTaskTransition(input: {
  task: TaskControlRecord;
  toStatus: HandoffStatus;
  note?: string | null;
  resolution?: JsonValue;
}): string | null {
  if (input.task.taskType !== "booking_action") return null;

  const resolution = record(input.resolution);
  const outcome = bookingOutcome(resolution.outcome);
  const note = clean(input.note);

  if (input.toStatus === "waiting_client") {
    if (
      outcome !== "alternative_offered" &&
      outcome !== "more_information_required"
    ) {
      return "Choose either ‘Alternative offered’ or ‘More information required’ before moving the booking task to Waiting for client.";
    }
    if (note.length < 5) {
      return "Add a short internal note explaining what the client must confirm or provide.";
    }
    return null;
  }

  if (input.toStatus === "waiting_internal") {
    if (outcome !== "waiting_internal") {
      return "Choose ‘Waiting for internal confirmation’ before moving the booking task to Waiting internal.";
    }
    if (note.length < 5) {
      return "Add a short internal note explaining which internal confirmation is outstanding.";
    }
    return null;
  }

  if (input.toStatus === "resolved") {
    if (
      outcome !== "appointment_confirmed" &&
      outcome !== "stylist_unavailable" &&
      outcome !== "client_declined" &&
      outcome !== "test_completed"
    ) {
      return "Choose a final booking outcome before resolving the task.";
    }

    if (note.length < 5) {
      return "Add a clear resolution note before closing the booking task.";
    }

    if (outcome === "appointment_confirmed") {
      const confirmedByHuman = resolution.confirmedByHuman === true;
      const bookingReference = clean(resolution.bookingReference);
      if (!confirmedByHuman) {
        return "A human receptionist must explicitly confirm that the appointment was created in Timely.";
      }
      if (bookingReference.length < 3 && note.length < 12) {
        return "Record the Timely booking reference or a sufficiently clear confirmation note.";
      }
    }
    return null;
  }

  if (input.toStatus === "cancelled") {
    if (outcome !== "client_declined" && outcome !== "test_completed") {
      return "Choose ‘Client declined’ or ‘Controlled test completed’ before cancelling this booking task.";
    }
    if (note.length < 5) {
      return "Add a clear cancellation note.";
    }
    return null;
  }

  if (input.toStatus === "accepted") return null;

  return "This booking outcome cannot be applied to the selected task status.";
}

export function returnToAiBlocker(tasks: TaskControlRecord[]): string | null {
  const open = tasks.filter(
    (task) => task.status !== "resolved" && task.status !== "cancelled",
  );

  const fullTakeover = open.find(
    (task) => task.scope === "full_takeover" || task.scope === "emergency",
  );
  if (fullTakeover) {
    return "Resolve the open full-takeover or emergency task before returning this conversation to AI.";
  }

  const ownedWork = open.find(
    (task) =>
      Boolean(task.ownerUserId) &&
      ["accepted", "waiting_client", "waiting_internal"].includes(task.status),
  );
  if (ownedWork) {
    return "Resolve or cancel the accepted human-action task before returning this conversation to AI.";
  }

  return null;
}
