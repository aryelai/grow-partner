function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateProfile(value = {}) {
  const nickname = cleanText(value.nickname, 30);
  const avatar = cleanText(value.avatar, 1024);
  if (!nickname) {
    return { valid: false, message: "昵称不能为空" };
  }
  if (avatar && !avatar.startsWith("cloud://")) {
    return { valid: false, message: "头像地址格式不正确" };
  }
  return { valid: true, data: { nickname, avatar } };
}

module.exports = { validateProfile };
