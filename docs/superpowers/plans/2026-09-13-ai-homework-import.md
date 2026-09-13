# AI 作业导入实施计划

**目标：** 在不改变当前线上环境和正在审核版本的前提下，完成截图临时上传、CloudBase 多模态识别、草稿确认和人工保存闭环。

**设计：** `docs/superpowers/specs/2026-09-13-ai-homework-import-design.md`

## 全局约束

- 仅在 `codex/ai-homework-import` 修改和本地提交，不推送、不部署。
- JavaScript ES6+、WXML、WXSS；不引入 UI 框架。
- 仅 `cloudfunctions/ai` 升级到官方 `wx-server-sdk@4.0.2` 并显式依赖 `@cloudbase/node-sdk@3.17.2`。
- 保持云存储客户端 `write:false`，运行时代码不得调用 `wx.cloud.uploadFile`。
- 身份、家庭、科目、日期、额度和任务所有权均由服务端重新校验。
- 先写失败测试，再实现；每个任务完成后运行相关测试。

## Task 1：识别与校验纯逻辑

**文件：**

- 新增 `cloudfunctions/ai/core.js`
- 新增 `tests/ai-import-core.test.js`

**工作：**

- 实现配置解析、文件元信息与魔数校验、北京时间日期、模型 JSON 提取、草稿字段规范化、提示词构造。
- 覆盖 1–3 张、4 MB 边界、非法 MIME、代码块 JSON、未知科目、模糊截止时间、超长字段和最多 20 条。

## Task 2：AI 云函数任务与临时文件闭环

**文件：**

- 修改 `cloudfunctions/ai/index.js`
- 修改 `cloudfunctions/ai/package.json`
- 新增 `tests/ai-import-service.test.js`

**工作：**

- 实现 `getStatus`、`createImportJob`、`analyzeImportJob`、`cancelImportJob`。
- 使用 `ai_import_jobs` 的确定性限流文档和随机任务文档；限制任务状态、所有者、家庭和过期时间。
- 使用 `@cloudbase/node-sdk` 获取精确上传元数据、读取/删除临时文件和调用 `createModel("cloudbase").generateText`。
- 测试无身份、孩子账号、配置缺失、额度耗尽、越权任务、越权取消、重复分析、文件伪造、AI 非 JSON、删除成功与删除失败。

## Task 3：客户端导入页与草稿确认

**文件：**

- 新增 `miniprogram/utils/ai-import.js`
- 新增 `miniprogram/pages/homework-import/*`
- 修改 `miniprogram/pages/homework-list/*`
- 修改 `miniprogram/app.json`
- 修改 `miniprogram/utils/permissions.js`
- 新增 `tests/ai-import-client.test.js`

**工作：**

- 增加 `importHomework` 权限，仅创建者和普通成员可用。
- 直接点击链路选择 1–3 张压缩截图，校验文件并依次使用服务端凭据上传。
- 展示上传/识别阶段；返回后提供草稿勾选、科目选择、主题/正文/要求/截止时间编辑。
- 上传阶段失败时尽力调用 `ai.cancelImportJob` 清理临时文件；确认后为每条草稿携带稳定 `requestId` 逐条调用 `homework.create`，由服务端幂等创建，成功项锁定，失败项保留并显示保存进度。
- 页面退出前提示尚未保存的草稿；不把截图写入作业附件。

## Task 4：静态门禁、文档与完整验证

**文件：**

- 修改 `scripts/validate-project.js`
- 修改 `tests/project-validation.test.js`
- 修改 `tests/family-beta-gate.test.js`
- 修改 `cloudfunctions/README.md`
- 修改 `README.md`

**工作：**

- 页面数调整为 17，允许 `wx.chooseMedia` 只出现在导入页，继续全局禁止 `wx.cloud.uploadFile`。
- AI 云函数单独允许已核实的 SDK 版本；其余八个云函数继续锁定 `3.0.1`。
- 记录后续部署需要的 `ai_import_jobs` 集合、客户端禁读写、`AI_MODEL`、`AI_DAILY_LIMIT`、请求合法域名、对象生命周期和用户隐私保护指引更新，不执行部署。
- 运行 `node --test tests/*.test.js`、`node scripts/validate-project.js`、`git diff --check`。

## Task 5：独立审查与验收

- 新建只读审查智能体，重点检查凭据泄露、任务越权、额度竞态、临时文件残留、模型输出注入、部分保存重复和静态门禁退化。
- Critical/Important 问题必须修复并重新回归；Minor 记录后由主控判断是否本轮处理。
- 主控重新运行完整测试并只提交本功能文件，提交信息使用简体中文。
