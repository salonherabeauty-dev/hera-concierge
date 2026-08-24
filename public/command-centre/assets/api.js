function cookie(name) {
    for (const item of document.cookie.split(";")) {
        const [key, ...parts] = item.trim().split("=");
        if (key === name)
            return decodeURIComponent(parts.join("="));
    }
    return "";
}
async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body)
        headers.set("Content-Type", "application/json");
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
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok) {
        const error = new Error(typeof payload.error === "string" ? payload.error : "The request could not be completed.");
        error.name = response.status === 401 ? "AuthenticationError" : "ApiError";
        throw error;
    }
    return payload;
}
export const commandApi = {
    session: () => request("/api/command-centre/auth/session"),
    login: (email, password) => request("/api/command-centre/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    }),
    logout: () => request("/api/command-centre/auth/logout", { method: "POST", body: "{}" }),
    dashboard: () => request("/api/command-centre/dashboard"),
    tasks: (status = "open") => request(`/api/command-centre/tasks?status=${encodeURIComponent(status)}`),
    conversations: (search = "") => request(`/api/command-centre/conversations?search=${encodeURIComponent(search)}`),
    conversation: (id) => request(`/api/command-centre/conversation?id=${encodeURIComponent(id)}`),
    acceptTask: (taskId, expectedVersion) => request("/api/command-centre/task-action", {
        method: "POST",
        body: JSON.stringify({ action: "accept", taskId, expectedVersion }),
    }),
    transitionTask: (taskId, expectedVersion, toStatus, note = "") => request("/api/command-centre/task-action", {
        method: "POST",
        body: JSON.stringify({ action: "transition", taskId, expectedVersion, toStatus, note, resolution: {} }),
    }),
    takeover: (conversationId, reason) => request("/api/command-centre/conversation", {
        method: "POST",
        body: JSON.stringify({ action: "takeover", conversationId, reason, takeoverUntil: null }),
    }),
    returnToAi: (conversationId, reason) => request("/api/command-centre/conversation", {
        method: "POST",
        body: JSON.stringify({ action: "return_to_ai", conversationId, reason }),
    }),
    addNote: (conversationId, note, taskId) => request("/api/command-centre/conversation", {
        method: "POST",
        body: JSON.stringify({ action: "add_note", conversationId, note, taskId: taskId ?? null }),
    }),
};
