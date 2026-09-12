const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const copiedEntries = ["miniprogram", "cloudfunctions", "scripts", "tests", "project.config.json"];

function withProjectCopy(mutate, verify) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grow-partner-validation-"));
  try {
    for (const entry of copiedEntries) {
      fs.cpSync(path.join(projectRoot, entry), path.join(temporaryRoot, entry), { recursive: true });
    }
    mutate(temporaryRoot);
    const result = spawnSync(process.execPath, [path.join(temporaryRoot, "scripts/validate-project.js")], {
      encoding: "utf8",
    });
    verify(result);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertValidationFailure(result, expectedError) {
  assert.notEqual(result.status, 0, `校验脚本应失败，实际输出：${result.stdout}${result.stderr}`);
  assert.match(result.stderr, expectedError);
}

test("错误 Cron 会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.triggers[0].config = "0 0 * * * * *";
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /提醒定时触发器不是每30分钟执行一次/));
});

test("提醒触发器名称错误会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.triggers[0].name = "otherTimer";
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /提醒定时触发器名称不正确/));
});

test("提醒触发器类型错误会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.triggers[0].type = "event";
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /提醒定时触发器类型不正确/));
});

test("提醒云函数缺少订阅消息发送权限会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    delete config.permissions;
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /提醒云函数未声明订阅消息发送权限/));
});

test("提醒云函数声明额外 OpenAPI 权限会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.permissions.openapi.push("wxacode.get");
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /提醒云函数 OpenAPI 权限必须限制为订阅消息发送/));
});

for (const [indexDescription, expectedError] of [
  ["users:                  familyId ASC, role ASC", /家庭成员物化查询索引缺失/],
  ["users:                  familyId ASC, openid ASC", /提醒接收人复核查询索引缺失/],
  ["reminder_deliveries:    recipientOpenid ASC, status ASC, deadlineAt ASC", /待提醒状态查询索引缺失/],
]) {
  test(`部署文档缺少 ${indexDescription.trim()} 会使项目静态校验失败`, () => {
    withProjectCopy((temporaryRoot) => {
      const guidePath = path.join(temporaryRoot, "cloudfunctions/README.md");
      const source = fs.readFileSync(guidePath, "utf8");
      fs.writeFileSync(guidePath, source.replace(indexDescription, ""));
    }, (result) => assertValidationFailure(result, expectedError));
  });
}

test("大小写错误的待办模板 ID 会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const corePath = path.join(temporaryRoot, "cloudfunctions/reminder/core.js");
    const source = fs.readFileSync(corePath, "utf8");
    fs.writeFileSync(corePath, source.replace("5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c", "5ly1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c"));
  }, (result) => assertValidationFailure(result, /待办事项提醒模板ID缺失|大小写错误的待办事项提醒模板ID/));
});

test("运行时代码包含日程模板 ID 会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const clientPath = path.join(temporaryRoot, "miniprogram/utils/subscription.js");
    const source = fs.readFileSync(clientPath, "utf8");
    fs.writeFileSync(clientPath, `${source}\nconst forbiddenTemplateId = "1fMjBkOzsEqXYVrQieX6ljtQ4lAKf8tIRn7GP2jDRew";\n`);
  }, (result) => assertValidationFailure(result, /检测到本轮禁用的日程提醒模板ID/));
});

test("运行时配置包含 AppSecret 会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const configPath = path.join(temporaryRoot, "cloudfunctions/reminder/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config[["app", "Secret"].join("")] = "fixture-secret-value";
    fs.writeFileSync(configPath, JSON.stringify(config));
  }, (result) => assertValidationFailure(result, /检测到疑似硬编码 AppSecret/));
});

test("运行时代码恢复客户端云存储上传会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const clientPath = path.join(temporaryRoot, "miniprogram/utils/api.js");
    const source = fs.readFileSync(clientPath, "utf8");
    fs.writeFileSync(clientPath, `${source}\nfunction unsafeUpload() { return wx.cloud.uploadFile({}); }\n`);
  }, (result) => assertValidationFailure(result, /家庭内测版运行时代码不得直接上传云存储文件/));
});

test("运行时代码恢复媒体选择会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const clientPath = path.join(temporaryRoot, "miniprogram/pages/login/login.js");
    const source = fs.readFileSync(clientPath, "utf8");
    fs.writeFileSync(clientPath, `${source}\nfunction unsafeChooseMedia() { return wx.chooseMedia({}); }\n`);
  }, (result) => assertValidationFailure(result, /家庭内测版运行时代码不得发起媒体选择/));
});

for (const [requiredText, expectedError] of [
  ["REGISTRATION_MODE=family_invite", /部署文档缺少家庭邀请码注册模式/],
  ['"write": "false"', /部署文档缺少云存储客户端禁写规则/],
]) {
  test(`部署文档缺少 ${requiredText} 会使项目静态校验失败`, () => {
    withProjectCopy((temporaryRoot) => {
      const guidePath = path.join(temporaryRoot, "cloudfunctions/README.md");
      const source = fs.readFileSync(guidePath, "utf8");
      fs.writeFileSync(guidePath, source.replaceAll(requiredText, ""));
    }, (result) => assertValidationFailure(result, expectedError));
  });
}

test("测试源码包含疑似 API Key 会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const fixturePath = path.join(temporaryRoot, "tests/fixture-secret.test.js");
    const fakeKey = ["sk", "fixturevalue1234567890"].join("-");
    fs.writeFileSync(fixturePath, `const leakedCredential = "${fakeKey}";\n`);
  }, (result) => assertValidationFailure(result, /检测到疑似硬编码 API Key/));
});

test("页面数量漂移会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const appConfigPath = path.join(temporaryRoot, "miniprogram/app.json");
    const appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
    appConfig.pages.pop();
    fs.writeFileSync(appConfigPath, JSON.stringify(appConfig));
  }, (result) => assertValidationFailure(result, /页面数量应为16个/));
});

test("通知详情页未注册会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    const appConfigPath = path.join(temporaryRoot, "miniprogram/app.json");
    const appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
    const detailIndex = appConfig.pages.indexOf("pages/notice-detail/notice-detail");
    appConfig.pages[detailIndex] = "pages/login/login";
    fs.writeFileSync(appConfigPath, JSON.stringify(appConfig));
  }, (result) => assertValidationFailure(result, /通知详情页未在 app.json 注册/));
});

test("云函数数量漂移会使项目静态校验失败", () => {
  withProjectCopy((temporaryRoot) => {
    fs.rmSync(path.join(temporaryRoot, "cloudfunctions/ai"), { recursive: true, force: true });
  }, (result) => assertValidationFailure(result, /云函数数量应为9个/));
});
