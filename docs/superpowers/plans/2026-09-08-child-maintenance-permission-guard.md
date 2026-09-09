# 孩子账号维护入口与上传前权限防护实施计划

> **供开发智能体执行：** 必须使用 `superpowers:subagent-driven-development` 按任务实施；行为修改严格遵循测试先行，并记录 RED/GREEN 证据。

**目标：** 在客户端隐藏孩子账号无权使用的作业、通知和计划维护入口，并在页面加载及写入、上传、删除方法处防御性拒绝孩子账号，同时保留云函数作为最终权限边界。

**架构：** 页面继续使用现有 `miniprogram/utils/permissions.js` 中的 `canPerform(role, action, context)` 作为唯一客户端角色判定入口。列表页从登录会话派生 `canManage` 状态供 WXML 隐藏维护入口，事件处理与编辑页生命周期再次检查权限；云函数权限逻辑不改动。云存储无法从安全规则直接读取 `users.role`，因此本轮只保证正常客户端路径不会由孩子触发上传，并把严格存储层阻断的限制写入部署门禁。

**技术栈：** 微信小程序原生 JavaScript、WXML、微信云开发、Node.js `node:test`

**规格：** `docs/superpowers/specs/2026-09-06-grow-partner-design.md`

## 全局约束

- 前端仅使用 WXML、WXSS、JavaScript 和微信小程序原生 API，不新增第三方依赖。
- 外部输入在云函数和页面边界同时校验；写操作按角色和资源所有权授权。
- 孩子只允许查看、作业状态切换、计划执行和习惯打卡，不能创建、编辑或删除作业、通知和计划。
- 客户端检查属于用户体验和纵深防御，云函数继续作为最终业务权限边界。
- 云存储规则不能直接读取项目 `users.role`；若要求阻止恶意客户端绕过页面直接上传，必须另行设计服务端授权上传流程。
- 测试名称、Git 提交信息使用简体中文；变量和函数标识符使用英文；代码注释使用简体中文。
- 本轮不得提交、推送、部署或发布；开发智能体只保留工作区差异并提交实施报告。

---

### Task 1: 为作业、通知和计划补齐客户端维护权限纵深防护

**文件：**

- 修改：`tests/permissions.test.js`
- 修改：`miniprogram/pages/homework-list/homework-list.js`
- 修改：`miniprogram/pages/homework-list/homework-list.wxml`
- 修改：`miniprogram/pages/homework-edit/homework-edit.js`
- 修改：`miniprogram/pages/homework-detail/homework-detail.js`
- 修改：`miniprogram/pages/notice-list/notice-list.js`
- 修改：`miniprogram/pages/notice-list/notice-list.wxml`
- 修改：`miniprogram/pages/notice-edit/notice-edit.js`
- 修改：`miniprogram/pages/plan-list/plan-list.js`
- 修改：`miniprogram/pages/plan-list/plan-list.wxml`
- 修改：`miniprogram/pages/plan-edit/plan-edit.js`
- 修改：`cloudfunctions/README.md`

**接口：**

- 使用：`canPerform(role, action, context = {}) -> boolean`
- 作业动作：列表新增和编辑页创建使用 `createHomework`，编辑现有作业使用 `updateHomework`，删除使用 `deleteHomework`
- 通知动作：创建、编辑、上传和删除统一使用 `manageNotice`
- 计划动作：创建、编辑和删除统一使用 `managePlan`
- 列表页面数据新增：`canManage: boolean`，初始为 `false`，会话加载后根据当前角色设置
- 不改变云函数 action、请求参数、返回结构或数据库结构

- [ ] **Step 1: 先编写能够捕获越权入口和越权副作用的失败测试**

在 `tests/permissions.test.js` 中扩充 `node:test` 测试。使用 `node:fs`、`node:path`、`node:vm` 载入真实页面脚本，通过自定义 `require` 只替换微信运行时边界 `requireFamily`、`callFunction`、`uploadFile` 和全局 `wx`；捕获真实 `Page({...})` 配置，不复制页面业务逻辑。

测试至少覆盖以下可观察行为，预期值使用字面量，不由生产代码计算：

```javascript
const restrictedActions = [
  "createHomework",
  "updateHomework",
  "deleteHomework",
  "manageNotice",
  "managePlan",
];

test("孩子不能执行作业通知和计划的维护动作", () => {
  for (const action of restrictedActions) {
    assert.equal(canPerform("child", action), false);
  }
});
```

页面行为采用表驱动断言：

```javascript
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function setByPath(target, key, value) {
  const segments = key.match(/[^.[\]]+/g);
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current[segment] === undefined) {
      current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function loadPage(relativePath, overrides = {}) {
  const sourcePath = path.resolve(__dirname, "..", relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const requireFromPage = createRequire(sourcePath);
  let pageConfig;
  const callFunctionCalls = [];
  const uploadFileCalls = [];
  const navigateToCalls = [];
  const navigateBackCalls = [];
  const showModalCalls = [];
  const chooseMediaCalls = [];
  const toastCalls = [];
  const session = overrides.session || {
    user: { role: "child", familyId: "family-1" },
    family: { currentSemester: "2026下", educationStage: "junior_high" },
  };
  const callFunction = async (...args) => {
    callFunctionCalls.push(args);
    if (args[0] === "settings") return { subjects: ["语文"] };
    if (args[0] === "homework") return { items: [], hasMore: false };
    if (args[0] === "notice") return { items: [], hasMore: false };
    if (args[0] === "plan") return { items: [] };
    throw new Error(`Unexpected cloud function: ${args[0]}`);
  };
  const uploadFile = async (...args) => {
    uploadFileCalls.push(args);
    return "cloud://file";
  };
  const wx = {
    navigateTo: (options) => navigateToCalls.push(options),
    navigateBack: () => navigateBackCalls.push(true),
    showToast: (options) => toastCalls.push(options),
    showModal: (options) => showModalCalls.push(options),
    chooseMedia: async (options) => {
      chooseMediaCalls.push(options);
      return { tempFiles: [] };
    },
    stopPullDownRefresh() {},
  };
  const context = vm.createContext({
    Page(config) { pageConfig = config; },
    wx,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    require(request) {
      if (request === "../../utils/api") return { callFunction, showError() {}, uploadFile };
      if (request === "../../utils/session") return { requireFamily: async () => session };
      return requireFromPage(request);
    },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(values) {
      for (const [key, value] of Object.entries(values)) setByPath(this.data, key, value);
    },
  };
  for (const [name, value] of Object.entries(pageConfig)) {
    if (typeof value === "function") page[name] = value.bind(page);
  }
  return { page, callFunctionCalls, uploadFileCalls, navigateToCalls, navigateBackCalls, showModalCalls, chooseMediaCalls, toastCalls };
}

const listPages = [
  { path: "miniprogram/pages/homework-list/homework-list.js", handlers: ["createHomework"] },
  { path: "miniprogram/pages/notice-list/notice-list.js", handlers: ["create", "edit"] },
  { path: "miniprogram/pages/plan-list/plan-list.js", handlers: ["create", "edit"] },
];

test("孩子会话加载后列表页隐藏维护入口且事件不会跳转", async () => {
  for (const item of listPages) {
    const fixture = loadPage(item.path);
    await fixture.page.onShow();
    assert.equal(fixture.page.data.canManage, false, item.path);
    for (const handler of item.handlers) {
      fixture.page[handler]({ currentTarget: { dataset: { id: "resource-1" } } });
    }
    assert.equal(fixture.navigateToCalls.length, 0, item.path);
  }
});

test("成人会话加载后列表页允许维护入口", async () => {
  for (const role of ["creator", "member"]) {
    for (const item of listPages) {
      const fixture = loadPage(item.path, {
        session: {
          user: { role, familyId: "family-1" },
          family: { currentSemester: "2026下", educationStage: "junior_high" },
        },
      });
      await fixture.page.onShow();
      assert.equal(fixture.page.data.canManage, true, `${role}: ${item.path}`);
      fixture.page[item.handlers[0]]({ currentTarget: { dataset: { id: "resource-1" } } });
      assert.equal(fixture.navigateToCalls.length, 1, `${role}: ${item.path}`);
    }
  }
});

test("孩子直接加载维护页时立即返回且不读取业务详情", async () => {
  const paths = [
    "miniprogram/pages/homework-edit/homework-edit.js",
    "miniprogram/pages/notice-edit/notice-edit.js",
    "miniprogram/pages/plan-edit/plan-edit.js",
  ];
  for (const pagePath of paths) {
    const fixture = loadPage(pagePath);
    await fixture.page.onLoad({ id: "resource-1" });
    assert.equal(fixture.navigateBackCalls.length, 1, pagePath);
    assert.equal(fixture.callFunctionCalls.length, 0, pagePath);
  }
});

test("孩子触发上传保存删除时不会产生外部副作用", async () => {
  const homeworkEdit = loadPage("miniprogram/pages/homework-edit/homework-edit.js");
  homeworkEdit.page.currentUser = { role: "child" };
  await homeworkEdit.page.chooseMedia();
  await homeworkEdit.page.save();
  assert.deepEqual([homeworkEdit.chooseMediaCalls.length, homeworkEdit.uploadFileCalls.length, homeworkEdit.callFunctionCalls.length], [0, 0, 0]);

  const homeworkDetail = loadPage("miniprogram/pages/homework-detail/homework-detail.js");
  homeworkDetail.page.currentUser = { role: "child" };
  homeworkDetail.page.remove();
  assert.deepEqual([homeworkDetail.showModalCalls.length, homeworkDetail.callFunctionCalls.length], [0, 0]);

  const noticeEdit = loadPage("miniprogram/pages/notice-edit/notice-edit.js");
  noticeEdit.page.currentUser = { role: "child" };
  await noticeEdit.page.chooseImages();
  await noticeEdit.page.save();
  noticeEdit.page.remove();
  assert.deepEqual([noticeEdit.chooseMediaCalls.length, noticeEdit.uploadFileCalls.length, noticeEdit.showModalCalls.length, noticeEdit.callFunctionCalls.length], [0, 0, 0, 0]);

  const planEdit = loadPage("miniprogram/pages/plan-edit/plan-edit.js");
  planEdit.page.currentUser = { role: "child" };
  await planEdit.page.save();
  planEdit.page.remove();
  assert.deepEqual([planEdit.showModalCalls.length, planEdit.callFunctionCalls.length], [0, 0]);

  assert.equal(homeworkEdit.toastCalls.at(-1).icon, "none");
  assert.equal(noticeEdit.toastCalls.at(-1).icon, "none");
  assert.equal(planEdit.toastCalls.at(-1).icon, "none");
});
```

测试装配实例时实现支持点路径的 `setData`，确保测试运行的是页面生命周期和事件方法，而不是只检查源码文本。云函数列表返回使用完整最小结构：作业 `{ items: [], hasMore: false }`、通知 `{ items: [], hasMore: false }`、计划 `{ items: [] }`，设置科目返回 `{ subjects: ["语文"] }`。

- [ ] **Step 2: 运行定向测试并确认 RED 原因正确**

运行：

```bash
node --test tests/permissions.test.js
```

预期：新增页面行为测试失败，失败原因是页面尚未派生 `canManage`、孩子事件仍会导航，或写入/上传/删除方法仍触发外部副作用；不得接受语法错误、测试装配错误或路径错误作为 RED。

- [ ] **Step 3: 用现有权限模型实现最小列表页防护**

在三个列表 JS 中引入：

```javascript
const { canPerform } = require("../../utils/permissions");
```

页面 `data` 添加 `canManage: false`。`onShow` 获得会话后保存 `this.currentUser = session.user`，并分别设置：

```javascript
canManage: canPerform(session.user.role, "createHomework")
canManage: canPerform(session.user.role, "manageNotice")
canManage: canPerform(session.user.role, "managePlan")
```

在 `createHomework`、通知 `create`/`edit`、计划 `create`/`edit` 入口中再次调用相同动作检查；无权限时只显示对应 `icon: "none"` 提示并返回，不调用 `wx.navigateTo`。WXML 对三个浮动新增按钮增加 `wx:if="{{canManage}}"`；通知卡片和计划标题仍保留事件绑定以避免复制展示结构，但事件方法必须在孩子账号下无副作用，因此孩子没有可用的编辑入口。

- [ ] **Step 4: 为编辑页加载、上传、保存和删除增加防御性检查**

三个编辑页和作业详情页引入 `canPerform`。编辑页 `onLoad` 在 `requireFamily()` 成功后立即保存 `this.currentUser = session.user`，并在任何科目读取、详情读取或数据写入前校验相应动作；拒绝时执行：

```javascript
wx.showToast({ title: "孩子账号不能新增或编辑此内容", icon: "none" });
wx.navigateBack();
return;
```

提示文字按领域替换“此内容”为“作业”“通知”或“计划”。作业页根据 `options.id` 在 `updateHomework` 与 `createHomework` 之间选择动作；通知和计划统一使用各自管理动作。

在以下方法第一行增加同一权限判断，无权限时提示并立即返回：

- `homework-edit.chooseMedia`、`homework-edit.save`
- `homework-detail.remove`，使用 `deleteHomework` 且仅为客户端拒绝孩子；普通成员的资源所有权继续由云函数最终校验
- `notice-edit.chooseImages`、`notice-edit.save`、`notice-edit.remove`
- `plan-edit.save`、`plan-edit.remove`

不得移动或放宽现有的表单校验、文件大小校验、重复提交状态、错误处理与云函数权限校验。

- [ ] **Step 5: 运行定向测试并确认 GREEN**

运行：

```bash
node --test tests/permissions.test.js
```

预期：全部通过，输出无错误和警告。随后进行变异检查：临时设想删除任一列表 handler 或编辑页副作用方法的权限分支，至少一条测试必须失败；如无测试失败，补充针对该公开行为的测试。

- [ ] **Step 6: 补充云存储部署门禁与限制说明**

在 `cloudfunctions/README.md` 的“安全与权限”附近新增“部署门禁”小节，明确：

```markdown
## 部署门禁

- [ ] 云存储安全规则至少拒绝未认证访问，并经过创建者、普通成员和孩子三种账号的真机验证。
- [ ] 创建者和普通成员可通过作业、通知页面完成允许的上传；孩子账号看不到维护入口，直接进入编辑页也不会触发 `wx.chooseMedia` 或 `wx.cloud.uploadFile`。
- [ ] 云函数仍需拒绝孩子创建、更新和删除作业、通知与计划，客户端检查不得替代服务端授权。
- [ ] 云存储规则无法直接读取 `users.role`。若验收要求阻止恶意孩子客户端绕过页面直接上传，当前架构不得上线，必须先改为服务端授权上传方案。
```

- [ ] **Step 7: 运行完整验证并自审工作区差异**

依次运行：

```bash
node --test tests/*.test.js
node scripts/validate-project.js
devres verify --target /Users/arye/projects/grow-partner
git diff --check
```

预期：测试全部通过；结构校验与 devres 校验成功；`git diff --check` 无输出且退出码为 0。检查 `git status --short`，只允许出现本任务列出的文件和本计划文件。不得暂存、提交或推送。
