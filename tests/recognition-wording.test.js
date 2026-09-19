const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const pagesRoot = path.join(projectRoot, "miniprogram/pages");
const forbiddenVisibleTerms = /\bAI\b|人工智能|大模型|多模态|生成草稿|从[^\n]*截图生成|模型偏好|Base URL|OpenAI/;

function listRuntimeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listRuntimeFiles(target);
    return /\.(?:js|json|wxml)$/.test(entry.name) ? [target] : [];
  });
}

test("用户可见的图片识别流程使用准确且统一的功能文案", () => {
  for (const file of listRuntimeFiles(pagesRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, forbiddenVisibleTerms, `${path.relative(projectRoot, file)} 包含不适合审核展示的功能文案`);
  }

  const serviceEntry = fs.readFileSync(path.join(projectRoot, "cloudfunctions/ai/index.js"), "utf8");
  assert.doesNotMatch(serviceEntry, forbiddenVisibleTerms);

  const homeworkList = fs.readFileSync(path.join(pagesRoot, "homework-list/homework-list.wxml"), "utf8");
  const noticeList = fs.readFileSync(path.join(pagesRoot, "notice-list/notice-list.wxml"), "utf8");
  const settings = fs.readFileSync(path.join(pagesRoot, "settings/settings.wxml"), "utf8");
  assert.match(homeworkList, />智能导入</);
  assert.match(noticeList, />智能导入</);
  assert.match(settings, /图片识别服务/);
  assert.match(settings, /所有结果都需由用户核对后保存/);
});
