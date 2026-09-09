const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCloudFunction(name, options = {}) {
  const { openid = "", role = "creator" } = options;
  const sourcePath = path.join(__dirname, `../cloudfunctions/${name}/index.js`);
  const source = fs.readFileSync(sourcePath, "utf8");
  let databaseReadCount = 0;
  const database = {
    command: {},
    collection() {
      databaseReadCount += 1;
      return {
        where() {
          return {
            limit() {
              return {
                async get() {
                  return {
                    data: [{
                      _id: "unexpected-user",
                      openid,
                      familyId: "family-id",
                      role,
                    }],
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database() { return database; },
    getWXContext() { return openid ? { OPENID: openid } : {}; },
  };
  const moduleValue = { exports: {} };
  const context = vm.createContext({
    console: { error() {}, info() {} },
    Date,
    Error,
    process: { env: {} },
    module: moduleValue,
    exports: moduleValue.exports,
    require(request) {
      if (request === "wx-server-sdk") return cloud;
      if (request === "crypto") return require("node:crypto");
      if (name === "reminder" && request === "./service") {
        return require("../cloudfunctions/reminder/service");
      }
      if (name === "notice" && request === "./reminder-policy") {
        const policyPath = path.join(__dirname, "../cloudfunctions/notice/reminder-policy.js");
        const policyModule = { exports: {} };
        const policyContext = vm.createContext({
          Date,
          Error,
          module: policyModule,
          exports: policyModule.exports,
        });
        vm.runInContext(fs.readFileSync(policyPath, "utf8"), policyContext, { filename: policyPath });
        return policyModule.exports;
      }
      throw new Error(`测试未实现依赖：${request}`);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return {
    main: moduleValue.exports.main,
    getDatabaseReadCount: () => databaseReadCount,
  };
}

for (const name of ["homework", "notice", "habit", "plan", "settings", "reminder"]) {
  test(`${name}云函数在缺少OpenID时不访问数据库`, async () => {
    const fixture = loadCloudFunction(name);

    const result = await fixture.main({ action: name === "reminder" ? "getStatus" : "unsupported" });

    assert.equal(result.success, false);
    assert.equal(fixture.getDatabaseReadCount(), 0);
  });
}

for (const name of ["homework", "notice", "habit", "plan", "settings", "reminder"]) {
  test(`${name}云函数拒绝未知用户角色`, async () => {
    const fixture = loadCloudFunction(name, { openid: "test-openid", role: "unexpected" });

    const result = await fixture.main({ action: "unsupported" });

    assert.equal(result.success, false);
    assert.equal(result.message, "请先登录并加入家庭");
  });
}
