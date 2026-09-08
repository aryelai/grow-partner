const test = require("node:test");
const assert = require("node:assert/strict");

const { canPerform } = require("../miniprogram/utils/permissions");

test("普通成员只能删除自己录入的作业", () => {
  assert.equal(canPerform("member", "deleteHomework", { ownsResource: true }), true);
  assert.equal(canPerform("member", "deleteHomework", { ownsResource: false }), false);
});

test("孩子只能执行允许的协作动作", () => {
  assert.equal(canPerform("child", "toggleHomework", {}), true);
  assert.equal(canPerform("child", "createHomework", {}), false);
});

test("普通成员仅在创建者开启后修改普通设置", () => {
  assert.equal(canPerform("member", "updateSettings", { allowMemberEditSettings: true }), true);
  assert.equal(canPerform("member", "updateSettings", { allowMemberEditSettings: false }), false);
});

test("只有创建者可以管理家庭成员", () => {
  assert.equal(canPerform("creator", "manageMembers", {}), true);
  assert.equal(canPerform("member", "manageMembers", {}), false);
});
