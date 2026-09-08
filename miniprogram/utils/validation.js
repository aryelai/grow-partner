function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateText(value, options = {}) {
  const normalized = normalizeText(value);
  const { required = false, maxLength = Number.MAX_SAFE_INTEGER } = options;
  if (required && normalized.length === 0) {
    return { valid: false, message: "此项不能为空" };
  }
  if (normalized.length > maxLength) {
    return { valid: false, message: `最多输入${maxLength}个字符` };
  }
  return { valid: true, message: "" };
}

function validateUrl(value) {
  const normalized = normalizeText(value);
  return /^https?:\/\/[^\s\u0000-\u001f]+$/i.test(normalized);
}

function escapeRegExp(value) {
  return normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampPageSize(value, defaultValue = 20) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.min(parsed, 50);
}

function validateArray(value, maxLength) {
  return Array.isArray(value) && value.length <= maxLength;
}

function validateIsoDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

module.exports = {
  normalizeText,
  validateText,
  validateUrl,
  validateArray,
  validateIsoDate,
  clampPageSize,
  escapeRegExp,
};
