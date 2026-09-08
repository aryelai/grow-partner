# 成长搭档微信小程序实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按固定技术栈交付可在微信开发者工具导入、部署云函数并联调的成长搭档小程序。

**Architecture:** 原生小程序页面通过统一请求封装调用按领域拆分的微信云函数；云函数从微信上下文解析身份，在服务端完成输入校验、权限判定、家庭隔离和数据读写。纯逻辑保持可由 Node.js 内置测试运行。

**Tech Stack:** 微信小程序原生 WXML/WXSS/JavaScript、微信云开发、Node.js 内置 `node:test`

**Spec:** `docs/superpowers/specs/2026-09-06-grow-partner-design.md`

> 状态说明（2026-09-08）：Task 1-6 的基础版代码均已落地；下方未勾选项保留为原始实施过程记录，不代表当前待办。当前可执行基线以根目录 `README.md`、`cloudfunctions/README.md` 和项目验证命令为准。

## Global Constraints

- 不使用第三方 UI 框架。
- 不使用 TypeScript。
- 不引入业务 npm 依赖。
- 当前学期默认值为 `2026下`，后续允许创建者切换。
- 所有云函数返回 `{ success: boolean, data: object|null, message: string }`。
- 所有业务查询强制使用服务端解析出的 `familyId`。
- 测试描述与 Git 提交信息使用简体中文。

---

### Task 1: Phase 0 项目骨架与纯函数

**Files:**
- Create: `project.config.json`
- Create: `miniprogram/app.js`
- Create: `miniprogram/app.json`
- Create: `miniprogram/app.wxss`
- Create: `miniprogram/sitemap.json`
- Create: `miniprogram/utils/constants.js`
- Create: `miniprogram/utils/date.js`
- Create: `miniprogram/utils/validation.js`
- Create: `miniprogram/utils/api.js`
- Test: `tests/date.test.js`
- Test: `tests/validation.test.js`

**Interfaces:**
- Produces: `getCurrentSemester(date)`, `getAdjacentSemester(semester, offset)`, `formatDate(date)`, `validateText(value, options)`, `validateUrl(value)`。

- [ ] **Step 1: 编写失败测试**

```javascript
test("一月归属上一自然年的下学期", () => {
  assert.equal(getCurrentSemester(new Date(2027, 0, 1)), "2026下");
});
```

- [ ] **Step 2: 验证测试失败**

Run: `node --test tests/date.test.js tests/validation.test.js`
Expected: FAIL，原因是目标模块尚不存在。

- [ ] **Step 3: 实现最小骨架和纯函数**

```javascript
function getCurrentSemester(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return month >= 2 && month <= 7 ? `${year}上` : `${month === 1 ? year - 1 : year}下`;
}
```

- [ ] **Step 4: 验证测试通过**

Run: `node --test tests/date.test.js tests/validation.test.js`
Expected: PASS。

### Task 2: Phase 0 登录与家庭协作

**Files:**
- Create: `miniprogram/pages/login/*`
- Create: `miniprogram/pages/family-create/*`
- Create: `miniprogram/pages/family-join/*`
- Create: `miniprogram/pages/family-members/*`
- Create: `cloudfunctions/login/index.js`
- Create: `cloudfunctions/family/index.js`
- Create: `cloudfunctions/README.md`
- Test: `tests/permissions.test.js`

**Interfaces:**
- Consumes: `RELATIONS`、`EDUCATION_STAGES`、`GRADES`、统一 `callFunction(name, action, data)`。
- Produces: `login.getProfile/register/updateProfile` 与 `family.create/searchByInviteCode/applyJoin/listRequests/reviewJoin/get/members/removeMember`。

- [ ] **Step 1: 编写角色与资源所有权失败测试**
- [ ] **Step 2: 运行 `node --test tests/permissions.test.js` 并确认失败**
- [ ] **Step 3: 实现 OpenID 注册、家庭邀请码、申请审批和成员管理**
- [ ] **Step 4: 运行全部 Node.js 测试并确认通过**

### Task 3: Phase 1 作业管理

**Files:**
- Create: `miniprogram/pages/homework-list/*`
- Create: `miniprogram/pages/homework-edit/*`
- Create: `miniprogram/pages/homework-detail/*`
- Create: `cloudfunctions/homework/index.js`
- Test: `tests/homework.test.js`

**Interfaces:**
- Produces: `homework.list/get/create/update/remove/toggleCompleted`；列表参数为 `semester`、`subject`、`status`、`keyword`、`page`、`pageSize`。

- [ ] **Step 1: 编写排序、分页和输入边界失败测试**
- [ ] **Step 2: 运行 `node --test tests/homework.test.js` 并确认失败**
- [ ] **Step 3: 实现服务端 CRUD、权限、家庭隔离和稳定排序**
- [ ] **Step 4: 实现横向科目标签、默认未完成、300ms 防抖、媒体与链接表单**
- [ ] **Step 5: 运行全部 Node.js 测试并确认通过**

### Task 4: Phase 2 通知、计划与习惯

**Files:**
- Create: `miniprogram/pages/notice-list/*`
- Create: `miniprogram/pages/notice-edit/*`
- Create: `miniprogram/pages/habit-list/*`
- Create: `miniprogram/pages/habit-detail/*`
- Create: `miniprogram/pages/plan-list/*`
- Create: `miniprogram/pages/plan-edit/*`
- Create: `cloudfunctions/notice/index.js`
- Create: `cloudfunctions/habit/index.js`
- Create: `cloudfunctions/plan/index.js`
- Test: `tests/habit.test.js`

**Interfaces:**
- Produces: 通知 CRUD；计划 CRUD 与子任务状态；习惯 CRUD、月度打卡、连续天数、积分。

- [ ] **Step 1: 编写连续打卡、积分里程碑和日期范围失败测试**
- [ ] **Step 2: 运行 `node --test tests/habit.test.js` 并确认失败**
- [ ] **Step 3: 实现三个领域云函数及家庭/学期隔离**
- [ ] **Step 4: 实现六个页面及日/周/月视图**
- [ ] **Step 5: 运行全部 Node.js 测试并确认通过**

### Task 5: Phase 3 设置与安全占位能力

**Files:**
- Create: `miniprogram/pages/settings/*`
- Create: `miniprogram/pages/subject-settings/*`
- Create: `cloudfunctions/settings/index.js`
- Create: `cloudfunctions/ai/index.js`
- Create: `cloudfunctions/reminder/index.js`

**Interfaces:**
- Produces: `settings.get/updateFamily/updatePreferences/getSubjects/addSubject/removeSubject/changeSemester`；AI 与提醒 action 返回明确的未启用状态。

- [ ] **Step 1: 编写设置权限和默认科目失败测试**
- [ ] **Step 2: 实现创建者设置、科目管理、学期切换和安全占位云函数**
- [ ] **Step 3: 实现设置页面和科目管理页面**
- [ ] **Step 4: 运行全部 Node.js 测试并确认通过**

### Task 6: 全量静态验证与交付说明

**Files:**
- Modify: `cloudfunctions/README.md`
- Create: `README.md`

**Interfaces:**
- Consumes: 全部页面、云函数和配置。
- Produces: 可执行的微信开发者工具导入、集合创建、索引配置和云函数部署说明。

- [ ] **Step 1: 运行 `node --test tests/*.test.js`**
- [ ] **Step 2: 对全部 `.js` 运行 `node --check`**
- [ ] **Step 3: 使用 Node.js 解析全部 `.json`**
- [ ] **Step 4: 扫描硬编码密钥、`any`、空 catch 和未隔离查询**
- [ ] **Step 5: 检查 `START.md` Phase 0-3 验收项并记录真实限制**
