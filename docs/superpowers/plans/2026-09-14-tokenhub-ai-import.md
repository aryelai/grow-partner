# TokenHub AI 作业导入实施计划

## 目标

在个人版微信云开发环境中，让现有 AI 作业导入通过云函数直接调用 TokenHub 多模态模型，以 `qwen3.5-flash` 作为默认候选，并保持可测试、可限额、可关闭和可回滚。

## 范围

- 在 `ai` 云函数增加 `tokenhub` 供应商适配层。
- 保留既有 `cloudbase` 模型调用作为回滚通道。
- 通过云函数环境变量管理供应商、模型、每日次数和 TokenHub API Key。
- 增加固定端点、模型白名单、结构化输出、绝对超时、响应体上限和安全错误映射。
- 更新自动化测试、部署说明和隐私处理边界。

## 非目标

- 本阶段不自动调用高精度 OCR，不让 OCR 结果覆盖模型结果。
- 不在没有真实密钥和脱敏样本的情况下调用付费接口或宣称识别效果达标。
- 不修改客户端作业确认与保存流程，不自动把模型结果写入数据库。
- 不在本计划中发布新的小程序正式版本。

## 架构

`homework-import` 页面继续使用服务端签发的临时上传凭据。`ai` 云函数下载并校验图片后，把统一的多模态消息交给供应商适配层：

- `tokenhub`：固定调用 TokenHub 官方 Chat Completions HTTPS 端点。`qwen3.5-flash` 关闭思考并请求严格 JSON Schema；`glm-5.3-flash` 使用低推理强度和 JSON 对象输出。
- `cloudbase`：沿用 `@cloudbase/node-sdk` 托管模型调用，作为显式配置的回滚通道。

两条通道返回统一响应，再进入既有的截断检查、JSON 解析、字段白名单、科目匹配和人工确认流程。

## 文件清单

- `cloudfunctions/ai/model-client.js`：供应商适配、TokenHub 请求和输出 Schema。
- `cloudfunctions/ai/core.js`：配置白名单与密钥存在性校验。
- `cloudfunctions/ai/index.js`：调用统一模型网关并映射公开错误。
- `tests/ai-model-client.test.js`：TokenHub 请求、安全失败和回滚通道测试。
- `tests/ai-import-core.test.js`、`tests/ai-import-service.test.js`：配置与服务回归测试。
- `cloudfunctions/README.md`、AI 导入设计文档：部署、隐私、评测与回滚说明。

## 顺序任务与完成证据

1. 先增加失败测试，证明旧实现不支持 TokenHub 配置和请求。
2. 实现最小供应商适配层，使相关测试通过。
3. 审查 API Key、SSRF、输入体积、响应体积、超时、日志和错误回显。
4. 更新部署与隐私说明，明确 TokenHub 图片处理边界。
5. 运行 `node --test tests/*.test.js`、`node scripts/validate-project.js` 和 `git diff --check`。
6. 用户在控制台配置最小权限 API Key 后，用 40–60 张脱敏样本做盲测，再决定是否正式启用以及是否增加选择性 OCR 复核。

## 风险与缓解

- 模型效果波动：保存前必须人工确认；上线前执行同批盲测。
- 成本失控：客户端每日次数限制和 TokenHub API Key 月度 token 上限同时生效。
- 密钥泄露：只放云函数环境变量；响应和日志不返回供应商配置。
- 图片数据出域：隐私指引明确临时存储、TokenHub 处理目的和删除策略。
- 上游异常：不自动重试付费请求；对鉴权、限流、超时、超大响应和其他失败做稳定映射。
- 供应商锁定：统一适配层保留 CloudBase 回滚路径，业务解析不依赖供应商响应扩展字段。

## 回滚

清空任一必要环境变量可立即关闭新导入任务；若已存在可用的 CloudBase 多模态模型，可把 `AI_PROVIDER` 切为 `cloudbase` 并设置对应 `AI_MODEL`。回滚不迁移数据库，也不影响既有作业数据。

## 外部确认点

- TokenHub API Key 必须由用户在控制台创建和配置，不能发送到聊天或提交到仓库。
- 云端真实调用和隐私保护指引发布前，必须核对模型访问范围、月度 token 上限、隐私文案和脱敏样本评测结果。
