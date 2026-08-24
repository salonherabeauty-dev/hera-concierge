import { z } from "zod";
import {
  HANDOFF_PRIORITIES,
  HANDOFF_SCOPES,
  HANDOFF_STATUSES,
  HANDOFF_TASK_TYPES,
} from "./types.js";

const ASSIGNABLE_ROLES = [
  "owner",
  "managing_director",
  "salon_manager",
  "receptionist",
  "technical_lead",
  "finance_admin",
  "privacy_officer",
] as const;

const uuid = z.string().uuid();
const optionalUuid = uuid.nullish().transform((value) => value ?? null);
const trimmed = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

export const bootstrapBodySchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(16).max(256),
  displayName: trimmed(2, 120),
});

export const loginBodySchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});

export const createTaskBodySchema = z.object({
  conversationId: uuid,
  sourceMessageId: optionalUuid,
  incidentId: optionalUuid,
  taskType: z.enum(HANDOFF_TASK_TYPES),
  scope: z.enum(HANDOFF_SCOPES),
  priority: z.enum(HANDOFF_PRIORITIES),
  assignedRole: z
    .enum(ASSIGNABLE_ROLES)
    .nullish()
    .transform((value) => value ?? null),
  assignedOutlet: z.string().trim().min(1).max(80).nullish().transform((value) => value ?? null),
  summary: trimmed(1, 1000),
  requestedAction: trimmed(1, 1200),
  collectedFacts: z.record(z.string(), z.json()).default({}),
  missingFacts: z.array(z.json()).default([]),
  clientVisibleStatus: z.string().trim().max(500).nullish().transform((value) => value ?? null),
  dueAt: z.string().datetime({ offset: true }).nullish().transform((value) => value ?? null),
  dedupeKey: trimmed(1, 220),
});

const taskActionBase = z.object({
  taskId: uuid,
  expectedVersion: z.number().int().min(1),
});

export const taskActionBodySchema = z.discriminatedUnion("action", [
  taskActionBase.extend({ action: z.literal("accept") }),
  taskActionBase.extend({
    action: z.literal("assign"),
    ownerUserId: uuid,
  }),
  taskActionBase.extend({
    action: z.literal("transition"),
    toStatus: z.enum(HANDOFF_STATUSES).refine(
      (value) => !["new", "assigned"].includes(value),
      "Invalid transition target",
    ),
    note: z.string().trim().max(2000).nullish().transform((value) => value ?? null),
    resolution: z.record(z.string(), z.json()).default({}),
  }),
]);

export const conversationActionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("takeover"),
    conversationId: uuid,
    reason: trimmed(3, 1000),
    takeoverUntil: z.string().datetime({ offset: true }).nullish().transform((value) => value ?? null),
  }),
  z.object({
    action: z.literal("return_to_ai"),
    conversationId: uuid,
    reason: trimmed(3, 1000),
  }),
  z.object({
    action: z.literal("add_note"),
    conversationId: uuid,
    taskId: optionalUuid,
    note: trimmed(1, 4000),
  }),
]);

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error("Command centre request validation failed");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return result.data;
}
