const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCloudFunction(name, database) {
  const sourcePath = path.join(__dirname, `../cloudfunctions/${name}/index.js`);
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
      if (request === "crypto") return require("node:crypto");
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return moduleValue.exports.main;
}

function createSingleResourceDatabase(collectionName, resource) {
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: "mother",
    role: "member",
  };
  return {
    collection(name) {
      if (name === "users") {
        return {
          where() {
            return { limit() { return { async get() { return { data: [user] }; } }; } };
          },
        };
      }
      if (name === collectionName) {
        return {
          doc() {
            return { async get() { return { data: resource }; } };
          },
        };
      }
      throw new Error(`测试未实现集合：${name}`);
    },
  };
}

for (const collectionName of ["homework", "notices", "plans"]) {
  test(`${collectionName}详情不会返回创建者OpenID`, async () => {
    const functionName = collectionName === "notices" ? "notice" : collectionName === "plans" ? "plan" : "homework";
    const resource = {
      _id: `${collectionName}-id`,
      familyId: "family-id",
      title: "测试记录",
      createdBy: "creator-openid",
      createdByName: "爸爸",
    };
    const main = loadCloudFunction(functionName, createSingleResourceDatabase(collectionName, resource));

    const result = await main({ action: "get", id: resource._id });

    assert.equal(result.success, true);
    assert.equal(Object.hasOwn(result.data, "createdBy"), false);
    assert.equal(result.data.createdByName, "爸爸");
  });
}

test("习惯详情不会返回创建者和打卡者OpenID", async () => {
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: "mother",
    role: "member",
  };
  const habit = {
    _id: "habit-id",
    familyId: "family-id",
    name: "测试习惯",
    targetDays: 21,
    createdBy: "creator-openid",
  };
  const checkIn = {
    _id: "check-in-id",
    habitId: "habit-id",
    familyId: "family-id",
    date: "2026-09-08",
    status: "completed",
    checkedBy: "妈妈",
    checkedByOpenid: "test-openid",
  };
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const database = {
    command: {
      gte() { return { and() { return {}; } }; },
      lte() { return {}; },
    },
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "habits") return { doc() { return { async get() { return { data: habit }; } }; } };
      if (name === "habit_checkins") {
        return {
          where() {
            return {
              orderBy() { return { limit() { return { async get() { return { data: [checkIn] }; } }; } }; },
            };
          },
        };
      }
      if (name === "habit_points") return { where() { return queryResult([{ totalPoints: 1 }]); } };
      throw new Error(`测试未实现集合：${name}`);
    },
  };
  const main = loadCloudFunction("habit", database);

  const result = await main({ action: "get", id: "habit-id", month: "2026-09", today: "2026-09-08" });

  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(result.data.habit, "createdBy"), false);
  assert.equal(Object.hasOwn(result.data.checkIns[0], "checkedByOpenid"), false);
  assert.equal(result.data.checkIns[0].checkedBy, "妈妈");
});
