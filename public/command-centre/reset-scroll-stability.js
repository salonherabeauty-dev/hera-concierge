const appRoot = document.querySelector("#reset-reception-app");

if (!(appRoot instanceof HTMLElement)) {
  throw new Error("Hera Reception Desk scroll-stability root was not found.");
}

const BOTTOM_PROXIMITY_PX = 56;
const threadScrollMemory = new Map();
let inboxScrollTop = 0;
let openingConversationId = null;
let restoreFrame = 0;

function selectedConversationId() {
  const selected = appRoot.querySelector(
    '.rr-row--selected[data-action="select"][data-id]',
  );
  return selected instanceof HTMLElement
    ? selected.getAttribute("data-id")
    : null;
}

function threadHasMessages(thread) {
  return Boolean(thread.querySelector(".rr-message"));
}

function rememberThreadPosition(thread, conversationId) {
  const maximum = Math.max(0, thread.scrollHeight - thread.clientHeight);
  threadScrollMemory.set(conversationId, {
    scrollTop: Math.max(0, Math.min(thread.scrollTop, maximum)),
    atBottom: maximum - thread.scrollTop <= BOTTOM_PROXIMITY_PX,
  });
}

function restoreThreadPosition(thread, conversationId) {
  if (openingConversationId === conversationId) {
    if (!threadHasMessages(thread)) return;
    thread.scrollTop = thread.scrollHeight;
    rememberThreadPosition(thread, conversationId);
    openingConversationId = null;
    return;
  }

  const remembered = threadScrollMemory.get(conversationId);
  if (remembered) {
    const maximum = Math.max(0, thread.scrollHeight - thread.clientHeight);
    thread.scrollTop = remembered.atBottom
      ? maximum
      : Math.min(remembered.scrollTop, maximum);
    return;
  }

  // The first complete render of a conversation should open at its newest
  // message. Subsequent automatic refreshes use the per-conversation memory.
  if (threadHasMessages(thread)) {
    thread.scrollTop = thread.scrollHeight;
    rememberThreadPosition(thread, conversationId);
  }
}

function restoreScrollPositions() {
  const inbox = appRoot.querySelector("[data-inbox-list]");
  if (inbox instanceof HTMLElement) {
    const maximum = Math.max(0, inbox.scrollHeight - inbox.clientHeight);
    inbox.scrollTop = Math.min(inboxScrollTop, maximum);
  }

  const thread = appRoot.querySelector("[data-thread]");
  const conversationId = selectedConversationId();
  if (!(thread instanceof HTMLElement) || !conversationId) return;
  restoreThreadPosition(thread, conversationId);
}

function scheduleScrollRestore() {
  // MutationObserver runs before the next paint in normal rendering. Restore
  // immediately to prevent a visible jump, then repeat once after layout has
  // settled in case fonts or responsive sizing changed the scroll height.
  restoreScrollPositions();
  window.cancelAnimationFrame(restoreFrame);
  const expectedConversationId = selectedConversationId();
  restoreFrame = window.requestAnimationFrame(() => {
    if (
      !expectedConversationId ||
      selectedConversationId() === expectedConversationId
    ) {
      restoreScrollPositions();
    }
  });
}

appRoot.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.matches("[data-thread]")) {
      const conversationId = selectedConversationId();
      if (conversationId) rememberThreadPosition(target, conversationId);
    } else if (target.matches("[data-inbox-list]")) {
      inboxScrollTop = target.scrollTop;
    }
  },
  true,
);

appRoot.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('[data-action="select"][data-id]')
      : null;
    const conversationId = target?.getAttribute("data-id") ?? null;
    if (!conversationId) return;

    // Opening a client intentionally starts at the newest message. Keep this
    // pending through the temporary empty render until the transcript arrives.
    openingConversationId = conversationId;
    threadScrollMemory.delete(conversationId);
  },
  true,
);

const observer = new MutationObserver(scheduleScrollRestore);
observer.observe(appRoot, { childList: true, subtree: true });
scheduleScrollRestore();
