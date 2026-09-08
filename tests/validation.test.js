const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeText,
  validateText,
  validateUrl,
  escapeRegExp,
} = require("../miniprogram/utils/validation");
const validation = require("../miniprogram/utils/validation");

test("文本规范化会去除首尾空白", () => {
  assert.equal(normalizeText("  数学作业  "), "数学作业");
});

test("必填文本拒绝纯空白内容", () => {
  assert.deepEqual(validateText("   ", { required: true, maxLength: 50 }), {
    valid: false,
    message: "此项不能为空",
  });
});

test("文本拒绝超过最大长度", () => {
  assert.equal(validateText("abcdef", { maxLength: 5 }).valid, false);
});

test("链接只接受 http 和 https 协议", () => {
  assert.equal(validateUrl("https://example.com/path"), true);
  assert.equal(validateUrl("javascript:alert(1)"), false);
});

test("搜索文本会安全转义正则元字符", () => {
  assert.equal(escapeRegExp("数学(1+1)"), "数学\\(1\\+1\\)");
});

test("ISO 日期校验拒绝不存在的自然日", () => {
  assert.equal(validation.validateIsoDate?.("2026-02-31"), false);
  assert.equal(validation.validateIsoDate?.("2028-02-29"), true);
});
