const root = document.querySelector("#reception-app");

if (!(root instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk automatic-draft status root was not found.");
}

let scheduled = false;

function patchAutomaticDraftStatus() {
  scheduled = false;
  const card = root.querySelector(".fd-status-card");
  if (!(card instanceof HTMLElement)) return;

  const heading = card.querySelector("strong")?.textContent?.trim() ?? "";
  const copy = card.querySelector("p");
  const button = card.querySelector('[data-action="create-ai-reply"]');

  if (/^AI reply is being prepared$/i.test(heading)) {
    button?.remove();
    if (copy instanceof HTMLElement) {
      copy.textContent =
        "The AI is preparing this reply automatically. No button press is required. A detailed or sensitive message may take several minutes.";
    }
    return;
  }

  if (/^No send-ready AI draft$/i.test(heading)) {
    if (button instanceof HTMLButtonElement) {
      button.textContent = "Retry AI Reply";
    }
    if (copy instanceof HTMLElement) {
      copy.textContent =
        "Automatic drafting did not complete. Retry once, or use Take Over / Hold for a fully manual reply.";
    }
  }
}

function schedulePatch() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(patchAutomaticDraftStatus);
}

const observer = new MutationObserver(schedulePatch);
observer.observe(root, { childList: true, subtree: true, characterData: true });
schedulePatch();
