const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  calculateStreak,
  calculateCheckInPoints,
} = require("../miniprogram/utils/habit");

function getShanghaiDate(offsetDays = 0) {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function loadHabitFunction(initialCheckIn, habitOverrides = {}) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/habit/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: "father",
    role: "creator",
  };
  const habit = {
    _id: "habit-id",
    familyId: "family-id",
    name: "测试习惯",
    frequency: "daily",
    targetDays: 21,
    checkInItems: [{ name: "完成今日目标", required: true }],
    startDate: "2000-01-01",
    endDate: null,
    isActive: true,
    ...habitOverrides,
  };
  let checkIn = initialCheckIn;
  let pointWriteCount = 0;
  const missingDocument = () => {
    const error = new Error("document does not exist");
    error.code = "DOCUMENT_NOT_FOUND";
    return error;
  };
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const transaction = {
    collection(name) {
      if (name === "habit_checkins") {
        return {
          doc() {
            return {
              async get() {
                if (!checkIn) throw missingDocument();
                return { data: checkIn };
              },
              async set({ data }) { checkIn = data; },
            };
          },
          where(query) {
            if (query.status === "completed") return queryResult(checkIn && checkIn.status === "completed" ? [checkIn] : []);
            return queryResult(checkIn ? [checkIn] : []);
          },
        };
      }
      if (name === "habit_points") {
        return {
          doc() {
            return {
              async get() { throw missingDocument(); },
              async set() { pointWriteCount += 1; },
            };
          },
        };
      }
      throw new Error(`测试事务未实现集合：${name}`);
    },
  };
  const database = {
    command: {
      gte() { return { and() { return {}; } }; },
      lte() { return {}; },
    },
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "habits") return { doc() { return { async get() { return { data: habit }; } }; } };
      throw new Error(`测试未实现集合：${name}`);
    },
    async runTransaction(callback) { return callback(transaction); },
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
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return {
    main: moduleValue.exports.main,
    getCheckIn: () => checkIn,
    getPointWriteCount: () => pointWriteCount,
  };
}

function loadHabitDateFunction(fixedNow) {
  const sourcePath = path.join(__dirname, "../cloudfunctions/habit/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const user = {
    _id: "user-id",
    openid: "test-openid",
    nickname: "测试用户",
    familyId: "family-id",
    relation: "father",
    role: "creator",
  };
  const habit = {
    _id: "habit-id",
    familyId: "family-id",
    name: "测试习惯",
    targetDays: 21,
    checkInItems: [{ name: "完成今日目标", required: true }],
    startDate: "2000-01-01",
    endDate: null,
    isActive: true,
  };
  const queriedRanges = [];
  const queryResult = (data) => ({ limit() { return { async get() { return { data }; } }; } });
  const database = {
    command: {
      gte(value) {
        return {
          and(endValue) {
            return { start: value, end: endValue.value };
          },
        };
      },
      lte(value) { return { value }; },
    },
    collection(name) {
      if (name === "users") return { where() { return queryResult([user]); } };
      if (name === "habits") {
        return {
          doc() { return { async get() { return { data: habit }; } }; },
          where() {
            return {
              async count() { return { total: 1 }; },
              orderBy() {
                return {
                  skip() {
                    return { limit() { return { async get() { return { data: [habit] }; } }; } };
                  },
                };
              },
            };
          },
        };
      }
      if (name === "habit_checkins") {
        return {
          where(query) {
            queriedRanges.push(query.date);
            return {
              orderBy() { return { limit() { return { async get() { return { data: [] }; } }; } }; },
            };
          },
        };
      }
      if (name === "habit_points") return { where() { return queryResult([]); } };
      throw new Error(`测试未实现集合：${name}`);
    },
  };
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() { return fixedNow; }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return database; },
    getWXContext() { return { OPENID: "test-openid" }; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {} },
    Date: FixedDate,
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
  return {
    main: moduleValue.exports.main,
    getQueriedRanges: () => queriedRanges,
  };
}

test("连续打卡忽略重复日期并计算到目标日期", () => {
  const streak = calculateStreak([
    { date: "2026-09-06", status: "completed" },
    { date: "2026-09-06", status: "completed" },
    { date: "2026-09-05", status: "completed" },
    { date: "2026-09-04", status: "partial" },
  ], "2026-09-06");

  assert.equal(streak, 2);
});

test("第七天打卡获得基础分和里程碑奖励", () => {
  assert.deepEqual(calculateCheckInPoints(7, false), {
    total: 4,
    entries: [
      { change: 1, reason: "完成每日打卡" },
      { change: 3, reason: "连续7天打卡奖励" },
    ],
  });
});

test("完成目标时叠加目标奖励", () => {
  assert.equal(calculateCheckInPoints(5, true).total, 51);
});

test("已获得积分的打卡反复修改状态不会再次加分", async () => {
  const today = getShanghaiDate();
  const fixture = loadHabitFunction({
    habitId: "habit-id",
    familyId: "family-id",
    date: today,
    status: "completed",
    items: [{ name: "完成今日目标", done: true }],
    pointsAwarded: true,
  });

  const incompleteResult = await fixture.main({
    action: "checkIn",
    habitId: "habit-id",
    date: today,
    items: [{ name: "完成今日目标", done: false }],
  });
  const repeatedResult = await fixture.main({
    action: "checkIn",
    habitId: "habit-id",
    date: today,
    items: [{ name: "完成今日目标", done: true }],
  });

  assert.equal(incompleteResult.success, true);
  assert.equal(repeatedResult.success, true);
  assert.equal(fixture.getCheckIn().pointsAwarded, true);
  assert.equal(fixture.getPointWriteCount(), 0);
});

test("习惯打卡拒绝非今日日期", async () => {
  const yesterday = getShanghaiDate(-1);
  const fixture = loadHabitFunction(null);

  const result = await fixture.main({
    action: "checkIn",
    habitId: "habit-id",
    date: yesterday,
    items: [{ name: "完成今日目标", done: true }],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "仅可保存今日打卡");
});

test("习惯打卡拒绝已停用习惯", async () => {
  const today = getShanghaiDate();
  const fixture = loadHabitFunction(null, { isActive: false });

  const result = await fixture.main({
    action: "checkIn",
    habitId: "habit-id",
    date: today,
    items: [{ name: "完成今日目标", done: true }],
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "当前习惯不在可打卡周期");
});

test("习惯列表未提供日期时按北京时间当天计算", async () => {
  const fixture = loadHabitDateFunction(Date.parse("2026-09-30T16:30:00.000Z"));

  const result = await fixture.main({ action: "list" });

  assert.equal(result.success, true);
  assert.deepEqual(fixture.getQueriedRanges(), [{ start: "2026-08-02", end: "2026-10-01" }]);
});

test("习惯详情未提供月份时按北京时间当前月查询", async () => {
  const fixture = loadHabitDateFunction(Date.parse("2026-09-30T16:30:00.000Z"));

  const result = await fixture.main({ action: "get", id: "habit-id" });

  assert.equal(result.success, true);
  assert.deepEqual(fixture.getQueriedRanges(), [
    { start: "2026-10-01", end: "2026-10-31" },
    { start: "2026-08-02", end: "2026-10-01" },
  ]);
});
