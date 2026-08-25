import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type {
  HandoffScope,
  HandoffStatus,
  HandoffTaskType,
} from "./types.js";
import type { TaskControlRecord } from "./operationPolicy.js";

interface TaskGuardRow {
  id: string;
  conversation_id: string;
  task_type: HandoffTaskType;
  scope: HandoffScope;
  status: HandoffStatus;
  owner_user_id: string | null;
  version: number;
}

function mapTask(row: TaskGuardRow): TaskControlRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskType: row.task_type,
    scope: row.scope,
    status: row.status,
    ownerUserId: row.owner_user_id,
    version: row.version,
  };
}

export class CommandCentreGuardRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-command-centre-guard/1.0" } },
    });
  }

  async getTask(taskId: string): Promise<TaskControlRecord> {
    const { data, error } = await this.database
      .from("ai_handoff_tasks")
      .select(
        "id,conversation_id,task_type,scope,status,owner_user_id,version",
      )
      .eq("id", taskId)
      .single();

    if (error || !data) throw new Error("handoff task not found");
    return mapTask(data as TaskGuardRow);
  }

  async listOpenTasks(conversationId: string): Promise<TaskControlRecord[]> {
    const { data, error } = await this.database
      .from("ai_handoff_tasks")
      .select(
        "id,conversation_id,task_type,scope,status,owner_user_id,version",
      )
      .eq("conversation_id", conversationId)
      .in("status", [
        "new",
        "assigned",
        "accepted",
        "waiting_client",
        "waiting_internal",
      ]);

    if (error) throw new Error(`load open handoff tasks: ${error.message}`);
    return (data ?? []).map((row) => mapTask(row as TaskGuardRow));
  }
}
