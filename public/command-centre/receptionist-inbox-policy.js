export function isInboundHumanHandling(conversation) {
  return Boolean(
    conversation &&
      conversation.operatingMode === "management" &&
      conversation.lastMessageDirection === "inbound",
  );
}

export function needsReplyInInbox(conversation) {
  return Boolean(
    conversation && conversation.lastMessageDirection === "inbound",
  );
}

export function matchesInboxSearch(conversation, rawSearch) {
  const search = String(rawSearch ?? "").trim().toLowerCase();
  if (!search) return true;
  return [
    conversation?.clientDisplayName,
    conversation?.phoneEnding,
    conversation?.lastMessagePreview,
  ].some((value) => String(value ?? "").toLowerCase().includes(search));
}
