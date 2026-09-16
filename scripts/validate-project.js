const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const errors = [];
const expectedPageCount = 22;
const expectedCloudFunctionCount = 10;
const todoTemplateId = "5Iy1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c";
const mistypedTodoTemplateId = "5ly1Jv7aswWNmrRMDXgrcj2BKeywdH6evDst6OomB2c";
const forbiddenCalendarTemplateId = "1fMjBkOzsEqXYVrQieX6ljtQ4lAKf8tIRn7GP2jDRew";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const files = [
  ...walk(path.join(projectRoot, "miniprogram")),
  ...walk(path.join(projectRoot, "cloudfunctions")),
  ...walk(path.join(projectRoot, "tests")),
];

for (const file of files.filter((item) => item.endsWith(".js"))) {
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file });
  } catch (error) {
    errors.push(`JavaScript 语法错误：${path.relative(projectRoot, file)}：${error.message}`);
  }
}

for (const file of [...files.filter((item) => item.endsWith(".json")), path.join(projectRoot, "project.config.json")]) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`JSON 格式错误：${path.relative(projectRoot, file)}：${error.message}`);
  }
}

const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "miniprogram/app.json"), "utf8"));
if (appConfig.pages.length !== expectedPageCount) errors.push(`页面数量应为${expectedPageCount}个`);
if (appConfig.pages[0] !== "pages/home/home") errors.push("默认首屏必须是允许游客浏览的首页");
if (!appConfig.pages.includes("pages/notice-detail/notice-detail")) errors.push("通知详情页未在 app.json 注册");
if (!appConfig.pages.includes("pages/homework-import/homework-import")) errors.push("AI 作业导入页未在 app.json 注册");
if (!appConfig.pages.includes("pages/notice-import/notice-import")) errors.push("AI 通知导入页未在 app.json 注册");
if (!appConfig.pages.includes("pages/timetable/timetable")) errors.push("课程表页未在 app.json 注册");
if (!appConfig.pages.includes("pages/timetable-edit/timetable-edit")) errors.push("课程编辑页未在 app.json 注册");
if (!appConfig.pages.includes("pages/timetable-import/timetable-import")) errors.push("AI 课程表导入页未在 app.json 注册");
if (new Set(appConfig.pages).size !== appConfig.pages.length) errors.push("app.json 存在重复页面配置");
for (const pagePath of appConfig.pages) {
  for (const extension of ["js", "json", "wxml", "wxss"]) {
    const file = path.join(projectRoot, "miniprogram", `${pagePath}.${extension}`);
    if (!fs.existsSync(file)) errors.push(`页面文件缺失：${path.relative(projectRoot, file)}`);
  }
}

for (const file of files.filter((item) => item.endsWith(".wxml"))) {
  const source = fs.readFileSync(file, "utf8");
  if (/\{\{[^}]*\.(?:includes|slice|map|filter)\s*\(/.test(source)) {
    errors.push(`WXML 包含不兼容的方法调用：${path.relative(projectRoot, file)}`);
  }
  const stack = [];
  const tagPattern = /<\/?([a-zA-Z][\w-]*)\b[^>]*\/?>/g;
  let matched;
  while ((matched = tagPattern.exec(source))) {
    const token = matched[0];
    const tag = matched[1];
    if (token.startsWith("</")) {
      const opening = stack.pop();
      if (opening !== tag) errors.push(`WXML 标签不匹配：${path.relative(projectRoot, file)}：${opening || "空"} / ${tag}`);
    } else if (!token.endsWith("/>")) {
      stack.push(tag);
    }
  }
  if (stack.length) errors.push(`WXML 存在未闭合标签：${path.relative(projectRoot, file)}：${stack.join(", ")}`);

  const pageScript = file.replace(/\.wxml$/, ".js");
  const scriptSource = fs.readFileSync(pageScript, "utf8");
  const handlerPattern = /\b(?:bind|catch)[a-z]+="([a-zA-Z_$][\w$]*)"/g;
  while ((matched = handlerPattern.exec(source))) {
    const handler = matched[1];
    if (!new RegExp(`\\b${handler}\\s*\\(`).test(scriptSource)) {
      errors.push(`WXML 事件处理器不存在：${path.relative(projectRoot, file)}：${handler}`);
    }
  }
}

for (const file of files.filter((item) => item.endsWith(".wxss"))) {
  const source = fs.readFileSync(file, "utf8");
  if (/display\s*:\s*grid/.test(source)) {
    errors.push(`WXSS 未遵循 Flex 布局约束：${path.relative(projectRoot, file)}`);
  }
}

const cloudRoot = path.join(projectRoot, "cloudfunctions");
const cloudFunctionEntries = fs.readdirSync(cloudRoot, { withFileTypes: true }).filter((item) => item.isDirectory());
if (cloudFunctionEntries.length !== expectedCloudFunctionCount) errors.push(`云函数数量应为${expectedCloudFunctionCount}个`);
for (const entry of cloudFunctionEntries) {
  const packageFile = path.join(cloudRoot, entry.name, "package.json");
  const indexFile = path.join(cloudRoot, entry.name, "index.js");
  if (!fs.existsSync(packageFile) || !fs.existsSync(indexFile)) {
    errors.push(`云函数入口不完整：${entry.name}`);
    continue;
  }
  const packageConfig = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const expectedSdkVersion = entry.name === "ai" ? "4.0.2" : "3.0.1";
  if (packageConfig.dependencies?.["wx-server-sdk"] !== expectedSdkVersion) {
    errors.push(`云函数 SDK 版本不一致：${entry.name}`);
  }
  if (entry.name === "ai" && packageConfig.dependencies?.["@cloudbase/node-sdk"] !== "3.17.2") {
    errors.push("AI 云函数缺少固定版本的 CloudBase Node SDK");
  }
}

const reminderConfigPath = path.join(cloudRoot, "reminder/config.json");
let reminderConfig = null;
try {
  reminderConfig = JSON.parse(fs.readFileSync(reminderConfigPath, "utf8"));
} catch {
  errors.push("提醒触发器配置无法读取");
}
const reminderTrigger = reminderConfig && Array.isArray(reminderConfig.triggers) && reminderConfig.triggers.length === 1
  ? reminderConfig.triggers[0]
  : null;
if (!reminderTrigger || reminderTrigger.name !== "reminderTimer") errors.push("提醒定时触发器名称不正确");
if (!reminderTrigger || reminderTrigger.type !== "timer") errors.push("提醒定时触发器类型不正确");
if (!reminderTrigger || reminderTrigger.config !== "0 */30 * * * * *") errors.push("提醒定时触发器不是每30分钟执行一次");
const reminderOpenApiPermissions = reminderConfig && reminderConfig.permissions && reminderConfig.permissions.openapi;
if (!Array.isArray(reminderOpenApiPermissions) || !reminderOpenApiPermissions.includes("subscribeMessage.send")) {
  errors.push("提醒云函数未声明订阅消息发送权限");
} else if (reminderOpenApiPermissions.length !== 1 || reminderOpenApiPermissions[0] !== "subscribeMessage.send") {
  errors.push("提醒云函数 OpenAPI 权限必须限制为订阅消息发送");
}
const deploymentGuideText = fs.readFileSync(path.join(cloudRoot, "README.md"), "utf8");
for (const [indexDescription, errorMessage] of [
  ["users:                  familyId ASC, role ASC", "家庭成员物化查询索引缺失"],
  ["users:                  familyId ASC, openid ASC", "提醒接收人复核查询索引缺失"],
  ["homework:               familyId ASC, semester ASC, createdAt DESC", "AI 重复检查最近作业索引缺失"],
  ["homework:               familyId ASC, homeworkDate ASC, createdAt DESC", "作业日期基础查询索引缺失"],
  ["homework:               familyId ASC, homeworkDate ASC, isCompleted ASC, createdAt DESC", "作业日期状态查询索引缺失"],
  ["homework:               familyId ASC, homeworkDate ASC, subject ASC, createdAt DESC", "作业日期科目查询索引缺失"],
  ["homework:               familyId ASC, homeworkDate ASC, subject ASC, isCompleted ASC, createdAt DESC", "作业日期科目状态查询索引缺失"],
  ["reminder_deliveries:    recipientOpenid ASC, status ASC, deadlineAt ASC", "待提醒状态查询索引缺失"],
]) {
  if (!deploymentGuideText.includes(indexDescription)) errors.push(errorMessage);
}

const runtimeFiles = files.filter((item) => !item.startsWith(`${path.join(projectRoot, "tests")}${path.sep}`));
const runtimeSourceText = runtimeFiles.filter((item) => /\.(?:js|json|wxml)$/.test(item)).map((item) => fs.readFileSync(item, "utf8")).join("\n");
const sourceText = files.filter((item) => /\.(?:js|json|wxml)$/.test(item)).map((item) => fs.readFileSync(item, "utf8")).join("\n");
if (!runtimeSourceText.includes(todoTemplateId)) errors.push("待办事项提醒模板ID缺失");
if (runtimeSourceText.includes(mistypedTodoTemplateId)) errors.push("检测到大小写错误的待办事项提醒模板ID");
if (runtimeSourceText.includes(forbiddenCalendarTemplateId)) errors.push("检测到本轮禁用的日程提醒模板ID");
if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(sourceText)) errors.push("检测到疑似硬编码 API Key");
if (/apiKey\s*[:=]\s*["'][^"']{8,}["']/.test(sourceText)) errors.push("检测到疑似硬编码 aiApiKey");
if (/["']?(?:appSecret|app_secret|APP_SECRET)["']?\s*[:=]\s*["'][^"']{8,}["']/i.test(sourceText)) errors.push("检测到疑似硬编码 AppSecret");
if (/wx\.cloud\.uploadFile\s*\(/.test(runtimeSourceText)) errors.push("家庭内测版运行时代码不得直接上传云存储文件");
if (/getPhoneNumber|open-type=["']chooseAvatar["']|type=["']nickname["']/.test(runtimeSourceText)) {
  errors.push("运行时代码不得在浏览前请求手机号、微信头像或微信昵称授权");
}
const guestPagePaths = ["home", "homework-list", "notice-list", "habit-list", "plan-list", "settings"];
for (const pageName of guestPagePaths) {
  const pageBase = path.join(projectRoot, "miniprogram/pages", pageName, pageName);
  const script = fs.readFileSync(`${pageBase}.js`, "utf8");
  const template = fs.readFileSync(`${pageBase}.wxml`, "utf8");
  if (!script.includes("requireFamily({ redirect: false })") || !script.includes("guestMode")) {
    errors.push(`核心页面缺少游客模式：${pageName}`);
  }
  if (!template.includes("guest-banner")) errors.push(`核心页面缺少游客提示：${pageName}`);
}
const loginTemplate = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/login/login.wxml"), "utf8");
const loginScript = fs.readFileSync(path.join(projectRoot, "miniprogram/pages/login/login.js"), "utf8");
if (!loginTemplate.includes('bindtap="continueExperience"') || !loginScript.includes("continueExperience()")) {
  errors.push("登录页缺少继续体验出口");
}
const shareScript = fs.readFileSync(path.join(projectRoot, "miniprogram/utils/share.js"), "utf8");
if (!shareScript.includes('path: "/pages/home/home"')) errors.push("分享入口必须落到游客可浏览首页");
const mediaSelectionFiles = runtimeFiles.filter((item) => item.endsWith(".js") && /wx\.chooseMedia\s*\(/.test(fs.readFileSync(item, "utf8")));
const allowedMediaSelectionFiles = [
  path.join(projectRoot, "miniprogram/pages/homework-import/homework-import.js"),
  path.join(projectRoot, "miniprogram/pages/notice-import/notice-import.js"),
  path.join(projectRoot, "miniprogram/pages/timetable-import/timetable-import.js"),
];
const mediaSelectionValid = mediaSelectionFiles.length === allowedMediaSelectionFiles.length
  && allowedMediaSelectionFiles.every((file) => mediaSelectionFiles.includes(file)
    && (fs.readFileSync(file, "utf8").match(/wx\.chooseMedia\s*\(/g) || []).length === 1);
if (!mediaSelectionValid) {
  errors.push("只有已注册的 AI 图片导入页可以发起媒体选择且每页只能调用一次");
}
if (!deploymentGuideText.includes("REGISTRATION_MODE=family_invite")) errors.push("部署文档缺少家庭邀请码注册模式");
if (!deploymentGuideText.includes('"write": "false"')) errors.push("部署文档缺少云存储客户端禁写规则");
if (!deploymentGuideText.includes("ai_import_jobs") || !deploymentGuideText.includes("AI_MODEL") || !deploymentGuideText.includes("AI_DAILY_LIMIT")) {
  errors.push("部署文档缺少 AI 作业导入配置");
}
if (!deploymentGuideText.includes("timetables")) errors.push("部署文档缺少课程表集合说明");

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`项目静态校验通过：${files.length} 个文件，${appConfig.pages.length} 个页面，${cloudFunctionEntries.length} 个云函数。`);
}
