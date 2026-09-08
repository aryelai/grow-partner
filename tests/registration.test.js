const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { validateProfile } = require("../cloudfunctions/login/profile");

function loadLoginFunction(database) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/login/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
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
      if (request === "./profile") return require("../cloudfunctions/login/profile");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

test("资料注册拒绝空昵称", () => {
  assert.deepEqual(validateProfile({ nickname: "   ", avatar: "" }), {
    valid: false,
    message: "昵称不能为空",
  });
});

test("资料注册接受昵称和云存储头像", () => {
  assert.deepEqual(validateProfile({
    nickname: "  成长伙伴  ",
    avatar: "cloud://cloud1/avatar.jpg",
  }), {
    valid: true,
    data: {
      nickname: "成长伙伴",
      avatar: "cloud://cloud1/avatar.jpg",
    },
  });
});

test("资料注册拒绝非云存储头像地址", () => {
  assert.deepEqual(validateProfile({
    nickname: "成长伙伴",
    avatar: "https://example.com/avatar.jpg",
  }), {
    valid: false,
    message: "头像地址格式不正确",
  });
});

test("并发注册触发唯一索引冲突时仍返回同一用户的注册结果", async () => {
  const existingUser = {
    _id: "existing-user-id",
    openid: "test-openid",
    nickname: "旧昵称",
    avatar: "",
    familyId: "",
    relation: "",
    role: "",
  };
  let lookupCount = 0;
  let updatedData = null;
  const database = {
    collection(name) {
      assert.equal(name, "users");
      return {
        where() {
          return {
            limit() {
              return {
                async get() {
                  lookupCount += 1;
                  return { data: lookupCount === 1 ? [] : [existingUser] };
                },
              };
            },
          };
        },
        async add() {
          const error = new Error("duplicate key");
          error.code = "DATABASE_DUPLICATE_WRITE";
          throw error;
        },
        doc(userId) {
          assert.equal(userId, existingUser._id);
          return {
            async update({ data }) {
              updatedData = data;
            },
          };
        },
      };
    },
  };
  const main = loadLoginFunction(database);

  const result = await main({
    action: "register",
    nickname: "新昵称",
    avatar: "cloud://test/avatar.jpg",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.nickname, "新昵称");
  assert.equal(result.data.avatar, "cloud://test/avatar.jpg");
  assert.equal(updatedData.nickname, "新昵称");
  assert.equal(updatedData.avatar, "cloud://test/avatar.jpg");
  assert.equal(updatedData.lastLoginAt instanceof Date, true);
});
