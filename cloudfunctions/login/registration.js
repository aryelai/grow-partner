const crypto = require("crypto");

const REGISTRATION_MODES = new Set(["open", "family_invite", "closed"]);
const INVITE_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

function getRegistrationMode(value = process.env.REGISTRATION_MODE) {
  return REGISTRATION_MODES.has(value) ? value : "closed";
}

function normalizeInviteCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]+/g, "") : "";
}

function isValidInviteCode(value) {
  return INVITE_CODE_PATTERN.test(normalizeInviteCode(value));
}

function createRegistrationAttemptId(openid, date) {
  const digest = crypto.createHash("sha256").update(`registration-invite:${openid}:${date}`).digest("hex").slice(0, 32);
  return `registration-invite-${digest}`;
}

module.exports = {
  createRegistrationAttemptId,
  getRegistrationMode,
  isValidInviteCode,
  normalizeInviteCode,
};
