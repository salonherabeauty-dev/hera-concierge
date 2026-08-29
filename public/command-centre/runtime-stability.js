(() => {
  // The Preview enhancement uses a MutationObserver. Make its task-button patch
  // idempotent so changing a label cannot recursively trigger the same observer.
  if (typeof window.patchTaskButtons === "function") {
    window.patchTaskButtons = function patchTaskButtonsIdempotently() {
      document.querySelectorAll('[data-action="resolve-task"]').forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) return;
        if (button.textContent !== "Choose outcome") {
          button.textContent = "Choose outcome";
        }
        if (!button.classList.contains("preview-outcome-button")) {
          button.classList.add("preview-outcome-button");
        }
      });
    };
  }

  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) return;

  let ready = false;
  const observer = new MutationObserver(() => {
    if (root.querySelector(".app-shell")) {
      ready = true;
      observer.disconnect();
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  window.setTimeout(() => {
    if (ready || root.querySelector(".app-shell")) return;
    const form = root.querySelector("#login-form");
    if (!(form instanceof HTMLFormElement)) return;
    if (form.querySelector("[data-command-centre-retry]")) return;

    const recovery = document.createElement("div");
    recovery.className = "login-card__header";
    recovery.setAttribute("role", "alert");
    recovery.innerHTML = `
      <p class="eyebrow">Secure Preview did not finish opening</p>
      <h2>Retry Command Centre</h2>
      <p>The protected session took too long to paint. No WhatsApp message was sent.</p>
      <button type="button" class="button button--primary button--full" data-command-centre-retry>Retry securely</button>
    `;
    form.replaceChildren(recovery);
  }, 10000);

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("[data-command-centre-retry]")
      : null;
    if (!target) return;
    window.location.reload();
  });
})();