function normalizeInviteCode(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function isValidInviteCode(value) {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalizeInviteCode(value));
}

function formatInviteCode(value) {
  const normalized = normalizeInviteCode(value);
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

module.exports = { normalizeInviteCode, isValidInviteCode, formatInviteCode };
