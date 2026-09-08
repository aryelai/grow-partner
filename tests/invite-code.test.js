const test = require("node:test");
const assert = require("node:assert/strict");

const clientInvite = require("../miniprogram/utils/invite-code");
const serverInvite = require("../cloudfunctions/family/invite-code");

test("邀请码输入会移除分隔符并转换为大写", () => {
  for (const invite of [clientInvite, serverInvite]) {
    assert.equal(invite.normalizeInviteCode(" abcd-efgh "), "ABCDEFGH");
  }
});

test("邀请码拒绝长度错误和容易混淆的字符", () => {
  for (const invite of [clientInvite, serverInvite]) {
    assert.equal(invite.isValidInviteCode("ABCDEFG"), false);
    assert.equal(invite.isValidInviteCode("ABCD0FGH"), false);
    assert.equal(invite.isValidInviteCode("ABCDIFGH"), false);
    assert.equal(invite.isValidInviteCode("ABCDEFGH"), true);
  }
});

test("服务端生成八位无歧义邀请码", () => {
  let index = 0;
  const code = serverInvite.generateInviteCode((max) => {
    const value = index % max;
    index += 1;
    return value;
  });

  assert.equal(code, "ABCDEFGH");
  assert.equal(serverInvite.isValidInviteCode(code), true);
});

test("邀请码按四位一组展示", () => {
  for (const invite of [clientInvite, serverInvite]) {
    assert.equal(invite.formatInviteCode("abcdefgh"), "ABCD-EFGH");
  }
});
