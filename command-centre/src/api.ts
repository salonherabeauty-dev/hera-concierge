import type { Conversation, ConversationDetail, Dashboard, Staff, Task, TaskStatus } from "./types.js";

function cookie(name: string): string {
  for (const item of document.cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Hera-CSRF", cookie("__Host-hera_cc_csrf"));
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? payload.error : "The request could not be completed.");
    error.name = response.status === 401 ? "AuthenticationError" : "ApiError";
    throw error;
  }
  return payload as T;
}

export const commandApi = {
  session: () => request<{ authenticated: boolean; staff?: Staff; csrfToken?: string }>("/api/command-centre/auth/session"),
  login: (email: string, password: string) =>
    request<{ ok: true; staff: Staff; csrfToken: string }>("/api/command-centre/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/command-centre/auth/logout", { method: "POST", body: "{}" }),
  dashboard: () => request<{ dashboard: Dashboard }>("/api/command-centre/dashboard"),
  tasks: (status = "open") => request<{ tasks: Task[] }>(`/api/command-centre/tasks?status=${encodeURIComponent(status)}`),
  conversations: (search = "") =>
    request<{ conversations: Conversation[] }>(`/api/command-centre/conversations?search=${encodeURIComponent(search)}`),
  conversation: (id: string) =>
    request<{ detail: ConversationDetail }>(`/api/command-centre/conversation?id=${encodeURIComponent(id)}`),
  acceptTask: (taskId: string, expectedVersion: number) =>
    request<{ result: unknown }>("/api/command-centre/task-action", {
      method: "POST",
      body: JSON.stringify({ action: "accept", taskId, expectedVersion }),
    }),
  transitionTask: (taskId: string, expectedVersion: number, toStatus: TaskStatus, note = "") =>
    request<{ result: unknown }>("/api/command-centre/task-action", {
      method: "POST",
      body: JSON.stringify({ action: "transition", taskId, expectedVersion, toStatus, note, resolution: {} }),
    }),
  takeover: (conversationId: string, reason: string) =>
    request<{ result: unknown }>("/api/command-centre/conversation", {
      method: "POST",
      body: JSON.stringify({ action: "takeover", conversationId, reason, takeoverUntil: null }),
    }),
  returnToAi: (conversationId: string, reason: string) =>
    request<{ result: unknown }>("/api/command-centre/conversation", {
      method: "POST",
      body: JSON.stringify({ action: "return_to_ai", conversationId, reason }),
    }),
  addNote: (conversationId: string, note: string, taskId?: string | null) =>
    request<{ result: unknown }>("/api/command-centre/conversation", {
      method: "POST",
      body: JSON.stringify({ action: "add_note", conversationId, note, taskId: taskId ?? null }),
    }),
};
