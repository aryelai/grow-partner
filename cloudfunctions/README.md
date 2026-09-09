# 云开发部署与数据设计

## 部署前准备

1. 在微信开发者工具中导入项目根目录，核对 `project.config.json` 的 `appid` 与当前要联调的小程序主体一致；AppID 不是密钥，但不得写入 AppSecret。
2. 创建云开发环境。`cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })` 会让云函数使用其所在环境，不需要在代码中硬编码环境 ID。
3. 创建下列集合并将客户端直接读写设为拒绝，业务访问统一经过云函数：`users`、`families`、`family_join_requests`、`family_search_limits`、`homework`、`notices`、`habits`、`habit_checkins`、`habit_points`、`habit_rewards`、`plans`、`settings`、`subjects`。
4. 逐个右键 `cloudfunctions` 下的函数目录，选择“上传并部署：云端安装依赖（不上传 node_modules）”。每个函数仅依赖官方 `wx-server-sdk@3.0.1`。
5. 创建 `families.inviteCode` 唯一索引；账号由云函数上下文中的 OpenID 识别，不采集手机号。

## 云函数与 action

| 云函数 | action |
| --- | --- |
| `login` | `getProfile`、`register`、`updateProfile` |
| `family` | `create`、`searchByInviteCode`、`applyJoin`、`listRequests`、`reviewJoin`、`get`、`members`、`removeMember` |
| `homework` | `list`、`get`、`create`、`update`、`remove`、`toggleCompleted` |
| `notice` | `list`、`get`、`create`、`update`、`remove` |
| `habit` | `list`、`get`、`create`、`update`、`checkIn`、`remove` |
| `plan` | `list`、`get`、`create`、`update`、`toggleItem`、`remove` |
| `settings` | `get`、`updatePreferences`、`changeSemester`、`updateFamily`、`getSubjects`、`addSubject`、`removeSubject` |
| `ai` | `getStatus`，其余 action 在基础版明确返回未启用 |
| `reminder` | `getStatus`，其余 action 在基础版明确返回未配置 |

所有 action 返回 `{ success, data, message }`。客户端不得传 `openid` 或以传入的 `familyId` 作为授权依据；云函数统一从 `cloud.getWXContext()` 和 `users` 集合解析身份。

## 核心集合

`users`、`families`、`homework`、`notices`、`habits`、`habit_checkins`、`habit_points`、`habit_rewards`、`plans`、`settings`、`subjects` 的核心字段遵循 `docs/START.md`。为执行完整业务规则，增加以下必要字段：

- `families.inviteCode`：服务端生成的 8 位无歧义邀请码，仅向家庭创建者返回。
- `family_join_requests`：`familyId`、`applicantOpenid`、`relation`、`status`、`createdAt`、`reviewedAt`、`reviewedBy`。该集合承载加入申请和审批。
- `family_search_limits`：`openid`、`date`、`count`、`updatedAt`。邀请码查询按微信用户每天最多 20 次，降低家庭信息枚举风险。
- `habits.semester`：保证切换学期后习惯按学期隔离。
- `plans.semester`：保证日/周/月计划按学期隔离。
- `plans.date`：三个计划类型都保存一个 ISO 日期锚点，列表据此计算日/周/月范围。
- `habits.endDate`：可空，用于持续或限定周期的习惯。
- `habit_checkins.pointsAwarded`：记录该日期是否已发放积分，防止反复修改打卡状态导致重复计分；旧记录若 `status` 已为 `completed`，按已发放处理。

AI Key 不在基础版中保存。`settings` 只保存供应商、Base URL、模型名和开关占位；正式 AI 集成应从云函数环境变量或密钥管理服务读取密钥，且不得返回客户端。

## 推荐索引

在云开发控制台按实际查询创建以下复合索引：

```text
users:                  openid ASC（唯一业务约束）
families:               inviteCode ASC（唯一业务约束）
family_join_requests:   familyId ASC, status ASC, createdAt ASC
family_join_requests:   applicantOpenid ASC, status ASC
family_search_limits:   openid ASC, date ASC
homework:               familyId ASC, semester ASC, subject ASC, isCompleted ASC, createdAt DESC
notices:                familyId ASC, semester ASC, category ASC, createdAt DESC
habits:                 familyId ASC, semester ASC, category ASC, isActive ASC, createdAt DESC
habit_checkins:         habitId ASC, date ASC
habit_checkins:         familyId ASC, status ASC
habit_points:           familyId ASC
plans:                  familyId ASC, semester ASC, type ASC, date ASC, createdAt DESC
settings:               familyId ASC
subjects:               familyId ASC, educationStage ASC, grade ASC
```

云数据库未自动保证业务唯一性时，需要通过控制台能力或后续服务端幂等键强化 `users.openid`、`families.inviteCode`、`habit_checkins(habitId,date)` 和单家庭 `settings` 的唯一约束。当前代码已做邀请码碰撞检查与重复打卡不重复计分，但高并发下仍应以数据库唯一约束作为最终防线。

## 安全与权限

- 所有资源读写都校验当前用户所属 `familyId`。
- 业务云函数在访问数据库前拒绝空 OpenID，并只接受 `creator`、`member`、`child` 三种已知角色。
- 孩子不能创建、编辑或删除作业、通知、计划和习惯，但可以完成作业、执行计划和打卡。
- 普通成员只能删除自己录入的作业；创建者可以管理家庭全部作业与成员。
- 家庭成员列表只返回页面所需的显式白名单字段，不返回 OpenID、历史手机号或最后登录时间。
- 作业、通知、计划和习惯响应不返回内部 `createdBy` 或 `checkedByOpenid`，页面只使用关系名称展示录入人与打卡人。
- 邀请码使用排除易混淆字符的 8 位编码；查询响应只返回最小家庭信息，提交申请时再次校验邀请码与家庭是否匹配。
- 邀请码只向家庭创建者展示，加入家庭仍需创建者批准。
- 习惯仅允许保存北京时间当天且处于启用周期内的打卡，同一日期的积分最多发放一次。
- 普通成员即使获准修改提醒偏好，也不能改写仅创建者可管理的 AI 供应商、Base URL 和模型配置。
- 通知与全局提醒对象只接受已定义的家庭关系枚举，未知值不会入库。
- 上传文件只保存 `cloud://` fileID，链接只允许 `http` 或 `https`。
- 生产环境应配置云存储安全规则、内容安全检测、订阅消息模板和数据备份策略。

## 部署门禁

- [ ] 云存储安全规则至少拒绝未认证访问，并经过创建者、普通成员和孩子三种账号的真机验证。
- [ ] 创建者和普通成员可通过作业、通知页面完成允许的上传；孩子账号看不到维护入口，直接进入编辑页也不会触发 `wx.chooseMedia` 或 `wx.cloud.uploadFile`。
- [ ] 云函数仍需拒绝孩子创建、更新和删除作业、通知与计划，客户端检查不得替代服务端授权。
- [ ] 云存储规则无法直接读取 `users.role`。若验收要求阻止恶意孩子客户端绕过页面直接上传，当前架构不得上线，必须先改为服务端授权上传方案。
