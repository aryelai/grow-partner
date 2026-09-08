const crypto = require("crypto");

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeInviteCode(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[\s-]+/g, "");
}

function isValidInviteCode(value) {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalizeInviteCode(value));
}

function generateInviteCode(randomInt = crypto.randomInt) {
  let result = "";
  for (let index = 0; index < 8; index += 1) {
    result += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return result;
}

function formatInviteCode(value) {
  const normalized = normalizeInviteCode(value);
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

module.exports = {
  normalizeInviteCode,
  isValidInviteCode,
  generateInviteCode,
  formatInviteCode,
};
