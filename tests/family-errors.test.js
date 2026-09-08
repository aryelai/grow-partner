const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFamilyFunction(familyError) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/family/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    avatar: "",
    familyId: "",
    relation: "",
    role: "",
  };
  const database = {
    collection(name) {
      if (name === "users") {
        return {
          where() {
            return { limit() { return { async get() { return { data: [user] }; } }; } };
          },
        };
      }
      if (name === "families") {
        return {
          doc() {
            return { async get() { throw familyError; } };
          },
        };
      }
      throw new Error(`测试未实现集合：${name}`);
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return database; },
    getWXContext() { return { OPENID: "test-openid" }; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    Error,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "crypto") return require("node:crypto");
      if (request === "./invite-code") return require("../cloudfunctions/family/invite-code");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

function loadFamilyMembersFunction(memberRecords) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/family/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const database = {
    collection(name) {
      assert.equal(name, "users");
      return {
        where(query) {
          const data = query.openid
            ? memberRecords.filter((item) => item.openid === query.openid)
            : memberRecords.filter((item) => item.familyId === query.familyId);
          return { limit() { return { async get() { return { data }; } }; } };
        },
      };
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return database; },
    getWXContext() { return { OPENID: "creator-openid" }; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    Error,
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "crypto") return require("node:crypto");
      if (request === "./invite-code") return require("../cloudfunctions/family/invite-code");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

test("提交加入申请时不会把数据库故障伪装成家庭不存在", async () => {
  const main = loadFamilyFunction(new Error("database timeout"));

  const result = await main({
    action: "applyJoin",
    familyId: "family-id",
    inviteCode: "ABCDEFGH",
    relation: "mother",
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "家庭服务暂时不可用，请稍后重试");
});

test("提交加入申请时将文档不存在识别为目标家庭不存在", async () => {
  const error = new Error("document.get:fail document does not exist");
  error.code = "DOCUMENT_NOT_FOUND";
  const main = loadFamilyFunction(error);

  const result = await main({
    action: "applyJoin",
    familyId: "family-id",
    inviteCode: "ABCDEFGH",
    relation: "mother",
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "目标家庭不存在");
});

test("家庭成员列表不会返回历史手机号和身份字段", async () => {
  const main = loadFamilyMembersFunction([
    {
      _id: "creator-id",
      openid: "creator-openid",
      phone: "13800000000",
      nickname: "创建者",
      avatar: "",
      familyId: "family-id",
      relation: "father",
      role: "creator",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      lastLoginAt: new Date("2026-09-08T00:00:00.000Z"),
    },
    {
      _id: "member-id",
      openid: "member-openid",
      phone: "13900000000",
      nickname: "家庭成员",
      avatar: "cloud://test/avatar.jpg",
      familyId: "family-id",
      relation: "mother",
      role: "member",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      lastLoginAt: new Date("2026-09-08T01:00:00.000Z"),
    },
  ]);

  const result = await main({ action: "members" });

  assert.equal(result.success, true);
  assert.equal(result.data.members.length, 2);
  for (const member of result.data.members) {
    assert.equal(Object.hasOwn(member, "openid"), false);
    assert.equal(Object.hasOwn(member, "phone"), false);
    assert.equal(Object.hasOwn(member, "familyId"), false);
    assert.equal(Object.hasOwn(member, "lastLoginAt"), false);
  }
  assert.deepEqual(
    Object.keys(result.data.members[1]).sort(),
    ["_id", "avatar", "createdAt", "nickname", "relation", "relationName", "role", "roleName"].sort(),
  );
});
