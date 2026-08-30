const root = document.querySelector("#reset-reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk reset recovery root was not found.");
}

const RECOVERY_INTERVAL_MS = 60_000;
let inFlight = false;
let lastAttemptAt = 0;

function cookie(name) {
  for (const item of document.cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

async function requestRecovery(force = false) {
  if (document.visibilityState !== "visible" || inFlight) return;
  const now = Date.now();
  if (!force && now - lastAttemptAt < RECOVERY_INTERVAL_MS) return;

  inFlight = true;
  lastAttemptAt = now;
  try {
    const response = await fetch("/api/command-centre/reset-recover", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Hera-CSRF": cookie("__Host-hera_cc_csrf"),
      },
      body: "{}",
    });
    if (!response.ok && response.status !== 401 && response.status !== 403) {
      console.warn("Reset v3 recovery request was not accepted.", response.status);
    }
  } catch {
    // The main workspace continues to show the authoritative ready/failed state.
    // A later focus or interval event will make one bounded recovery request.
  } finally {
    inFlight = false;
  }
}

window.setTimeout(() => void requestRecovery(true), 1_500);
window.setInterval(() => void requestRecovery(), RECOVERY_INTERVAL_MS);
window.addEventListener("focus", () => void requestRecovery(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void requestRecovery(true);
});
