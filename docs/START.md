# 成长搭档（Grow Partner）微信小程序 — 开发指令

> 在开始开发之前，请先阅读本文件同目录下的「成长搭档PRD.md」完整需求文档。本文档是开发执行指令，PRD是需求依据。

## 项目定位

一款面向初中生家庭的微信小程序，帮助家长管理孩子的作业、通知、习惯养成和日常计划。核心用户是家长（爸爸/妈妈），孩子作为辅助用户。

## 技术栈（固定，不可更改）

- 前端：微信小程序原生框架（WXML + WXSS + JS，**不使用任何第三方UI框架**）
- 后端：微信云开发（云函数 + 云数据库 + 云存储）
- 数据库：云数据库（文档型，类似MongoDB）
- **本项目不使用任何业务 npm 依赖**；云函数部署仅使用官方 `wx-server-sdk` 运行时依赖
- **不使用TypeScript**，纯JavaScript

## 项目结构

```
project/
├── project.config.json          # 项目配置
├── cloudfunctions/              # 云函数（每个模块一个云函数）
│   ├── login/                   # 登录/注册/用户信息
│   ├── family/                  # 家庭创建/加入/成员管理
│   ├── homework/                # 作业CRUD/列表/搜索/标记完成
│   ├── notice/                  # 通知CRUD/列表
│   ├── habit/                   # 习惯CRUD/打卡/积分
│   ├── plan/                    # 计划CRUD/列表
│   ├── settings/                # 设置获取/更新
│   ├── ai/                      # AI接口调用（预留，基础版可为空壳）
│   └── reminder/                # 定时提醒（预留，基础版可为空壳）
├── miniprogram/
│   ├── app.js                   # 全局逻辑（含登录状态管理）
│   ├── app.json                 # 全局配置（含tabBar）
│   ├── app.wxss                 # 全局样式（含CSS变量）
│   ├── pages/
│   │   ├── login/               # 登录/注册页
│   │   ├── family-create/       # 创建家庭
│   │   ├── family-join/         # 加入家庭
│   │   ├── family-members/      # 家庭成员管理
│   │   ├── homework-list/       # 作业列表（Tab1 核心页）
│   │   ├── homework-detail/     # 作业详情
│   │   ├── homework-edit/       # 新增/编辑作业
│   │   ├── notice-list/         # 通知列表（Tab2）
│   │   ├── notice-edit/         # 新增/编辑通知
│   │   ├── habit-list/          # 习惯列表（Tab3）
│   │   ├── habit-detail/        # 习惯详情（打卡日历）
│   │   ├── plan-list/           # 计划列表（Tab4）
│   │   ├── plan-edit/           # 新增/编辑计划
│   │   └── settings/            # 设置（Tab5）
│   └── utils/
│       ├── date.js              # 日期工具（学期计算等）
│       └── constants.js         # 枚举常量（学段/关系/科目等）
└── docs/
    ├── 成长搭档PRD.md            # 完整需求文档（已存在，请先阅读）
    └── START.md                 # 本文件
```

## 开发顺序（必须严格遵守）

### Phase 0（基础架构）
1. 项目初始化（app.json配置、tabBar配置、全局样式变量）
2. `utils/constants.js` — 枚举常量定义
3. `utils/date.js` — 日期工具函数（含学期计算）
4. 登录页 — OpenID 身份识别 + 昵称头像注册 + 判断是否已注册
5. 创建家庭页 — 完整表单
6. 加入家庭页 — 家庭邀请码搜索 + 申请加入
7. 家庭成员管理页 — 查看/移除成员
8. 云函数：`login`（登录/注册/获取用户信息）
9. 云函数：`family`（创建/加入/成员管理/获取家庭信息）
10. 数据库集合设计文档写入 `cloudfunctions/README.md`

### Phase 1（核心功能 - 作业管理）
1. `utils/constants.js` 补充默认科目列表
2. 作业列表页（Tab1）：
   - 学期切换（左右箭头 + 中间显示当前学期）
   - 科目标签栏（**横向滚动标签，非下拉菜单**，单选）
   - 状态筛选（全部/未完成/已完成，**默认"未完成"**）
   - 搜索框（按主题模糊搜索，防抖300ms）
   - 作业卡片列表（含排序规则）
3. 新增作业页 — 完整表单
4. 编辑作业页 — 复用新增页逻辑
5. 作业详情页
6. 云函数：`homework`（CRUD + 列表查询 + 搜索 + 标记完成）
7. 标记完成/取消完成功能

### Phase 2（扩展功能）
1. 通知管理：
   - 通知列表页（Tab2）：分类筛选、搜索
   - 新增/编辑通知页
   - 云函数：`notice`
2. 计划管理：
   - 计划列表页（Tab4）：日/周/月视图切换
   - 新增/编辑计划页
   - 云函数：`plan`
3. 习惯养成：
   - 习惯列表页（Tab3）：分类切换、进度条、连续天数
   - 习惯详情页：日历打卡视图、今日打卡
   - 驼背矫正专项设计（多打卡项）
   - 云函数：`habit`
4. 积分系统（基础版）：
   - 打卡积分累计
   - 积分记录查询

### Phase 3（设置与其他）
1. 设置页（Tab5）：
   - 家庭信息展示与编辑
   - 家庭成员管理入口
   - 科目管理入口
   - AI配置占位（开关+表单，暂不接实际功能）
   - 通知提醒设置
2. 科目管理功能：
   - 默认科目展示
   - 添加自定义科目
   - 删除自定义科目
3. 学期切换功能：
   - 设置页中切换当前学期
   - 切换后所有业务数据按新学期过滤

## 数据库集合定义（必须严格遵循）

> 所有集合名和字段名必须与以下定义一致。所有业务集合（除users和families外）都必须包含`familyId`字段用于数据隔离。

### users（用户表）

| 字段        | 类型   | 说明                           |
| ----------- | ------ | ------------------------------ |
| _id         | string | 自动生成                       |
| openid      | string | 微信openid，唯一               |
| nickname    | string | 微信昵称                       |
| avatar      | string | 头像URL                        |
| familyId    | string | 所属家庭ID（未加入家庭时为空） |
| relation    | string | 关系枚举值                     |
| role        | string | creator / member / child       |
| createdAt   | date   | 注册时间                       |
| lastLoginAt | date   | 最后登录时间                   |

### families（家庭表）

| 字段                    | 类型    | 说明                                               |
| ----------------------- | ------- | -------------------------------------------------- |
| _id                     | string  | 自动生成                                           |
| childName               | string  | 孩子姓名（必填）                                   |
| childNickname           | string  | 昵称（选填）                                       |
| childBirthday           | date    | 生日                                               |
| educationStage          | string  | kindergarten / primary / junior_high / senior_high |
| grade                   | string  | 小班/中班/大班/1/2/3/4/5/6                         |
| className               | string  | 班级名称                                           |
| currentSemester         | string  | 如"2026下"                                         |
| inviteCode              | string  | 服务端生成的8位家庭邀请码，唯一                    |
| creatorOpenid           | string  | 创建者openid                                       |
| allowMemberEditSettings | boolean | 默认false                                          |
| createdAt               | date    | 创建时间                                           |

### homework（作业表）

| 字段             | 类型    | 说明                                |
| ---------------- | ------- | ----------------------------------- |
| _id              | string  | 自动生成                            |
| familyId         | string  | 家庭ID                              |
| semester         | string  | 学期                                |
| subject          | string  | 科目                                |
| title            | string  | 主题（必填，最大50字）              |
| content          | string  | 详细内容（选填，最大2000字）        |
| images           | array   | 图片fileID数组（最多9张）           |
| videos           | array   | 视频fileID数组（最多1个）           |
| links            | array   | 链接数组（最多5个）                 |
| extraRequirement | string  | 附加要求（选填，最大100字）         |
| isImportant      | boolean | 是否重要，默认false                 |
| hasDeadline      | boolean | 是否限时，默认false                 |
| deadline         | date    | 截止时间（hasDeadline为true时必填） |
| extraTags        | array   | 额外标签（最多10个）                |
| isCompleted      | boolean | 是否完成，默认false                 |
| createdAt        | date    | 录入时间                            |
| createdBy        | string  | 录入人openid                        |
| createdByName    | string  | 录入人关系名（爸爸/妈妈等）         |

### notices（通知表）

| 字段          | 类型    | 说明                                              |
| ------------- | ------- | ------------------------------------------------- |
| _id           | string  | 自动生成                                          |
| familyId      | string  | 家庭ID                                            |
| semester      | string  | 学期                                              |
| title         | string  | 标题（必填）                                      |
| content       | string  | 内容                                              |
| images        | array   | 图片                                              |
| source        | string  | 来源（如"班主任-王老师"）                         |
| category      | string  | flag_raising / exam / activity / homework / other |
| remindTime    | date    | 提醒时间（选填）                                  |
| remindAdvance | array   | 提前分钟数，如[1440, 120]                         |
| remindTargets | array   | 提醒对象关系列表                                  |
| isReminded    | boolean | 是否已提醒                                        |
| createdAt     | date    | 创建时间                                          |
| createdBy     | string  | 创建人openid                                      |
| createdByName | string  | 创建人关系名                                      |

### habits（习惯表）

| 字段         | 类型    | 说明                      |
| ------------ | ------- | ------------------------- |
| _id          | string  | 自动生成                  |
| familyId     | string  | 家庭ID                    |
| name         | string  | 习惯名称                  |
| category     | string  | behavior / life / study   |
| description  | string  | 描述                      |
| frequency    | string  | daily / weekly            |
| targetDays   | number  | 目标天数                  |
| checkInItems | array   | 打卡项 [{name, required}] |
| startDate    | date    | 开始日期                  |
| isActive     | boolean | 是否启用                  |
| reward       | string  | 完成奖励说明              |
| createdAt    | date    | 创建时间                  |
| createdBy    | string  | 创建人openid              |

### habit_checkins（打卡记录表）

| 字段            | 类型   | 说明                         |
| --------------- | ------ | ---------------------------- |
| _id             | string | 自动生成                     |
| habitId         | string | 习惯ID                       |
| familyId        | string | 家庭ID                       |
| date            | string | YYYY-MM-DD                   |
| status          | string | completed / partial / missed |
| items           | array  | [{name, done}]               |
| photo           | string | 照片fileID（选填）           |
| note            | string | 备注（选填）                 |
| checkedBy       | string | 打卡人关系名                 |
| checkedByOpenid | string | 打卡人openid                 |
| createdAt       | date   | 打卡时间                     |

### habit_points（积分表）

| 字段        | 类型   | 说明                     |
| ----------- | ------ | ------------------------ |
| _id         | string | 自动生成                 |
| familyId    | string | 家庭ID                   |
| totalPoints | number | 总积分                   |
| history     | array  | [{date, change, reason}] |

### habit_rewards（奖励表）

| 字段      | 类型    | 说明     |
| --------- | ------- | -------- |
| _id       | string  | 自动生成 |
| familyId  | string  | 家庭ID   |
| name      | string  | 奖励名称 |
| cost      | number  | 所需积分 |
| isActive  | boolean | 是否启用 |
| createdAt | date    | 创建时间 |

### plans（计划表）

| 字段              | 类型    | 说明                          |
| ----------------- | ------- | ----------------------------- |
| _id               | string  | 自动生成                      |
| familyId          | string  | 家庭ID                        |
| type              | string  | daily / weekly / monthly      |
| date              | string  | YYYY-MM-DD（日计划）          |
| title             | string  | 标题                          |
| items             | array   | [{text, isDone, priority}]    |
| assignee          | string  | father / mother / child / all |
| notes             | string  | 备注                          |
| linkedHomeworkIds | array   | 关联作业ID                    |
| linkedHabitIds    | array   | 关联习惯ID                    |
| isCompleted       | boolean | 是否完成                      |
| createdAt         | date    | 创建时间                      |
| createdBy         | string  | 创建人openid                  |
| createdByName     | string  | 创建人关系名                  |

### settings（设置表）

| 字段                    | 类型    | 说明                                |
| ----------------------- | ------- | ----------------------------------- |
| _id                     | string  | 自动生成                            |
| familyId                | string  | 家庭ID                              |
| aiEnabled               | boolean | 默认false                           |
| aiProvider              | string  | deepseek / openai / claude / custom |
| aiApiKey                | string  | API密钥（基础版不落库；正式版从服务端密钥管理读取） |
| aiBaseUrl               | string  | API地址                             |
| aiModel                 | string  | 模型名称                            |
| reminderDefaultAdvance  | array   | 默认[1440, 120]                     |
| reminderTargets         | array   | 提醒对象                            |
| allowMemberEditSettings | boolean | 默认false                           |
| updatedAt               | date    | 更新时间                            |

### subjects（科目表）

| 字段           | 类型   | 说明           |
| -------------- | ------ | -------------- |
| _id            | string | 自动生成       |
| familyId       | string | 家庭ID         |
| educationStage | string | 学段           |
| grade          | string | 年级           |
| subjects       | array  | 默认科目列表   |
| customSubjects | array  | 自定义科目     |
| order          | object | {科目名: 序号} |
| updatedAt      | date   | 更新时间       |

## 核心业务规则

### 学期计算（utils/date.js 必须实现）

```javascript
function getCurrentSemester(date) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (month >= 2 && month <= 7) {
    return `${year}上`;
  } else {
    return `${year}下`;
  }
}
// 注意：8月-次年1月属于"当年下"
// 例：2026年9月 → "2026下"；2027年1月 → "2026下"；2027年3月 → "2027上"
```

### 默认科目列表（utils/constants.js 必须实现）

```javascript
const DEFAULT_SUBJECTS = {
  kindergarten: ["语言", "数学启蒙", "英语启蒙", "科学", "艺术", "体育", "社会"],
  primary: ["语文", "数学", "英语", "科学", "道德与法治", "音乐", "美术", "体育", "信息技术", "劳动"],
  junior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "道德与法治", "历史", "地理", "音乐", "美术", "体育", "信息技术", "劳动技术"],
  senior_high: ["语文", "数学", "英语", "物理", "化学", "生物", "政治", "历史", "地理", "音乐", "美术", "体育", "通用技术", "信息技术"]
};
```

### 关系枚举（utils/constants.js 必须实现）

```javascript
const RELATIONS = {
  father: "爸爸",
  mother: "妈妈",
  grandpa_paternal: "爷爷",
  grandma_paternal: "奶奶",
  grandpa_maternal: "外公",
  grandma_maternal: "外婆",
  uncle_paternal: "叔叔",
  aunt_paternal: "婶婶",
  uncle_maternal: "舅舅",
  aunt_maternal: "舅妈",
  brother: "哥哥",
  sister: "姐姐",
  child: "孩子"
};
```

### 作业列表排序规则

```
优先级从高到低：
1. isCompleted=false（未完成）在前，isCompleted=true（已完成）在后
2. hasDeadline=true 且未过期 → 按deadline升序（最近的截止时间排最前）
3. isImportant=true 在前
4. createdAt 倒序（最新录入的在前）
```

### 作业卡片显示规则

```
第一行：[⭐ 如果isImportant] [🔔 如果hasDeadline] 标题 （附加要求-红色括弧包裹）
第二行：科目 | 录入人 | 截止时间（如有限时）
第三行：[额外标签1] [额外标签2] ...
底部状态：未完成（🟡）/ 已完成（✅ 置灰+删除线）
```

- 附加要求（extraRequirement）在列表中始终显示，红色字体，括弧包裹在标题后
- 已完成作业：整条卡片置灰，标题加删除线
- 过期未完成的限时作业：截止时间显示红色

### 权限规则

| 操作               | creator | member | child |
| ------------------ | :-----: | :----: | :---: |
| 查看所有数据       |    ✅    |   ✅    |   ✅   |
| 新增/编辑作业      |    ✅    |   ✅    |   ❌   |
| 删除自己录入的作业 |    ✅    |   ✅    |   ❌   |
| 删除他人录入的作业 |    ✅    |   ❌    |   ❌   |
| 新增/编辑通知      |    ✅    |   ✅    |   ❌   |
| 新增习惯           |    ✅    |   ✅    |   ❌   |
| 习惯打卡           |    ✅    |   ✅    |   ✅   |
| 新增计划           |    ✅    |   ✅    |   ❌   |
| 标记作业完成       |    ✅    |   ✅    |   ✅   |
| 管理家庭成员       |    ✅    |   ❌    |   ❌   |
| 修改家庭信息       |    ✅    |   ❌    |   ❌   |
| 修改设置           |    ✅    |   ❌    |   ❌   |

### 学期切换规则

- 创建者在设置中切换当前学期
- 切换后，所有业务数据查询（作业/通知/习惯/计划）仅返回当前学期的数据
- 旧学期数据保留在数据库中，不显示，不删除
- 家庭表的currentSemester字段更新

### 数据隔离规则

- **所有业务数据的查询必须带familyId条件**
- 用户登录后，从users表获取familyId
- 所有云函数必须校验请求用户的familyId与数据的familyId是否匹配

## 代码规范

### 云函数规范

- 每个云函数使用 `event.action` 进行分发
- 返回格式统一：`{ success: boolean, data: any, message: string }`
- 使用 `async/await`，不使用回调嵌套
- 权限校验在每个action内部处理
- 数据库查询必须分页，默认每页20条

### 前端规范

- 每个页面包含 .wxml / .wxss / .js / .json 四个文件
- 使用 `wx.cloud.callFunction` 调用云函数
- 页面数据通过 `data` 属性管理
- 样式使用 flex 布局
- 颜色使用CSS变量定义在app.wxss中

### 全局样式变量（app.wxss）

```css
page {
  --primary: #4A90D9;
  --danger: #E74C3C;
  --warning: #F39C12;
  --success: #27AE60;
  --gray: #95A5A6;
  --bg: #F5F6FA;
  --card-bg: #FFFFFF;
  --text: #2C3E50;
  --text-light: #7F8C8D;
}
```

### TabBar配置（app.json）

```json
"tabBar": {
  "list": [
    { "pagePath": "pages/homework-list/homework-list", "text": "作业" },
    { "pagePath": "pages/notice-list/notice-list", "text": "通知" },
    { "pagePath": "pages/habit-list/habit-list", "text": "习惯" },
    { "pagePath": "pages/plan-list/plan-list", "text": "计划" },
    { "pagePath": "pages/settings/settings", "text": "设置" }
  ]
}
```

## 验收标准

### Phase 0 验收
1. 新用户可完成：OpenID 身份识别 → 完善昵称头像 → 创建家庭 → 获取邀请码 → 进入主界面
2. 第二个用户可完成：OpenID 身份识别 → 完善昵称头像 → 输入家庭邀请码 → 发送申请
3. 创建者可批准/拒绝加入申请
4. 家庭成员可看到彼此信息

### Phase 1 验收（核心）
1. 可新增一条作业（含科目、主题、内容、附加要求、重要标记、限时时间）
2. 作业列表中：科目筛选可用（标签式）、状态筛选默认未完成、搜索可用
3. 附加要求在列表中显示为红色括弧
4. 重要作业前面有⭐标识
5. 限时作业显示截止时间
6. 标记完成的作业置灰+删除线
7. 切换学期后，之前的作业隐藏
8. 家庭成员各自录入的作业，所有人都能看到
9. 排序规则正确：未完成在前、限时按截止时间升序、重要优先

### Phase 2 验收
1. 通知可新增/编辑/删除，分类筛选可用
2. 计划可新增/编辑/删除，日/周/月视图切换正常
3. 习惯可创建，打卡日历正确显示
4. 打卡记录正确保存，连续天数计算正确

## 注意事项（重要）

1. **不要使用任何第三方组件库**
2. **不要使用TypeScript**
3. **不要引入业务 npm 包**；云函数仅使用官方 `wx-server-sdk`
4. **科目标签筛选必须是横向滚动标签**，不是下拉菜单
5. **所有日期存储使用ISO格式**，显示时转换为友好格式
6. **先读PRD.md文件**，再开始开发
7. **数据库集合名和字段名必须与本文档一致**
8. **所有云函数返回格式统一**
9. **当前学期为"2026下"**（开发时硬编码，后续可切换）
10. **tabBar共5个Tab**：作业、通知、习惯、计划、设置

## 工具适配

你正在使用Codex进行开发。项目位于grow-partner文件夹。直接从Phase 0开始，按顺序实现所有功能。每完成一个Phase，简要总结已完成的功能和文件清单，然后继续下一个Phase。不需要停下来等待确认。
