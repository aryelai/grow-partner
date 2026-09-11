# 云开发部署与数据设计

## 部署前准备

1. 在微信开发者工具中导入项目根目录，核对 `project.config.json` 的 `appid` 与当前要联调的小程序主体一致；AppID 不是密钥，但不得写入 AppSecret。
2. 创建云开发环境。`cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })` 会让云函数使用其所在环境，不需要在代码中硬编码环境 ID。
3. 创建下列集合并将客户端直接读写设为拒绝，业务访问统一经过云函数：`users`、`families`、`family_join_requests`、`family_search_limits`、`homework`、`notices`、`habits`、`habit_checkins`、`habit_points`、`habit_rewards`、`plans`、`settings`、`subjects`、`message_subscriptions`、`reminder_deliveries`。其中后两个订阅提醒集合必须明确设置为客户端不可读、不可写。
4. 逐个右键 `cloudfunctions` 下的函数目录，选择“上传并部署：云端安装依赖（不上传 node_modules）”。每个函数仅依赖官方 `wx-server-sdk@3.0.1`。
5. 创建 `families.inviteCode` 唯一索引和“推荐索引”列出的复合索引；账号由云函数上下文中的 OpenID 识别，不采集手机号。

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
| `reminder` | 客户端可调用 `getStatus`、`recordSubscription`；`run` 仅接受 `SOURCE === "wx_trigger"` 的定时触发，不能由客户端 action 调用 |

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
- `message_subscriptions`：按当前 OpenID 和待办模板保存预计可用次数、最近订阅结果及受控请求编号；文档 ID 由服务端生成，客户端禁止直接读写。
- `reminder_deliveries`：按通知、提醒版本、接收人和模板生成确定性发送记录，保存调度、占用、发送、失败或取消状态；客户端禁止直接读写。

AI Key 不在基础版中保存。`settings` 只保存供应商、Base URL、模型名和开关占位；正式 AI 集成应从云函数环境变量或密钥管理服务读取密钥，且不得返回客户端。

## 推荐索引

在云开发控制台按实际查询创建以下复合索引：

```text
users:                  openid ASC（唯一业务约束）
users:                  familyId ASC, role ASC
users:                  familyId ASC, openid ASC
families:               inviteCode ASC（唯一业务约束）
family_join_requests:   familyId ASC, status ASC, createdAt ASC
family_join_requests:   applicantOpenid ASC, status ASC
family_search_limits:   openid ASC, date ASC
homework:               familyId ASC, semester ASC, subject ASC, isCompleted ASC, createdAt DESC
notices:                familyId ASC, semester ASC, category ASC, createdAt DESC
notices:                reminderState ASC, scheduledAt ASC
habits:                 familyId ASC, semester ASC, category ASC, isActive ASC, createdAt DESC
habit_checkins:         habitId ASC, date ASC
habit_checkins:         familyId ASC, status ASC
habit_points:           familyId ASC
plans:                  familyId ASC, semester ASC, type ASC, date ASC, createdAt DESC
settings:               familyId ASC
subjects:               familyId ASC, educationStage ASC, grade ASC
reminder_deliveries:    status ASC, nextAttemptAt ASC
reminder_deliveries:    noticeId ASC, reminderVersion ASC
reminder_deliveries:    recipientOpenid ASC, status ASC, deadlineAt ASC
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
- `message_subscriptions` 和 `reminder_deliveries` 必须设置为客户端不可读、不可写；订阅登记只能更新当前微信身份，不能接受客户端提供的 OpenID、`familyId` 或预计次数。
- 待办模板 ID 可以作为受控常量保存；不得保存 AppSecret，也不得请求或发送本轮禁用的日程提醒模板。
- `reminder.run` 只接受精确的微信定时触发来源 `SOURCE === "wx_trigger"`，不提供客户端测试发送入口。
- 上传文件只保存 `cloud://` fileID，链接只允许 `http` 或 `https`。
- 生产环境应配置云存储安全规则、内容安全检测、订阅消息模板和数据备份策略。

## 部署门禁

- [ ] 云存储安全规则至少拒绝未认证访问，并经过创建者、普通成员和孩子三种账号的真机验证。
- [ ] 创建者和普通成员可通过作业、通知页面完成允许的上传；孩子账号看不到维护入口，直接进入编辑页也不会触发 `wx.chooseMedia` 或 `wx.cloud.uploadFile`。
- [ ] 云函数仍需拒绝孩子创建、更新和删除作业、通知与计划，客户端检查不得替代服务端授权。
- [ ] 云存储规则无法直接读取 `users.role`。若验收要求阻止恶意孩子客户端绕过页面直接上传，当前架构不得上线，必须先改为服务端授权上传方案。

## 订阅提醒开发环境部署记录（2026-09-11）

本仓库已完成订阅提醒的本地代码、自动化测试和静态校验，并在用户明确授权后部署到唯一目标环境 `cloud1-d3g2hleood2cae7e7`。本次没有点击腾讯云页面的“免费开发”入口，也没有创建第二套环境。

1. 创建 `message_subscriptions`、`reminder_deliveries` 集合，并把两者的客户端权限设为不可读、不可写；保存后重新打开规则页面核对。
2. 创建并等待以下复合索引变为可用：

   ```text
   users:                 familyId ASC, role ASC
   users:                 familyId ASC, openid ASC
   notices:               reminderState ASC, scheduledAt ASC
   reminder_deliveries:  status ASC, nextAttemptAt ASC
   reminder_deliveries:  noticeId ASC, reminderVersion ASC
   reminder_deliveries:  recipientOpenid ASC, status ASC, deadlineAt ASC
   ```

3. 为 `reminder` 云函数配置 `MINIPROGRAM_STATE=developer`。该值只允许 `developer`、`trial`、`formal`；缺失或非法时服务端会禁用发送。不得配置或上传 AppSecret。
4. 上传并部署全部九个云函数。订阅提醒变更至少涉及 `settings`、`notice` 和 `reminder`；部署 `reminder` 前核对其 `config.json` 已在 `permissions.openapi` 中声明最小权限 `subscribeMessage.send`。均选择“云端安装依赖（不上传 node_modules）”，部署后核对状态为 `Active`。
5. 核对 `reminderTimer` 已安装，类型为 `timer`，Cron 精确为 `0 */30 * * * * *`，即每 30 分钟一次；同时确认控制台按北京时间解释调度窗口。

执行结果：

- `message_subscriptions`、`reminder_deliveries` 已创建，客户端权限均为不可读、不可写。
- 上述六个复合索引已存在并完成核对。
- `reminder` 已配置 `MINIPROGRAM_STATE=developer`，未配置或上传 AppSecret。
- `ai`、`family`、`habit`、`homework`、`login`、`notice`、`plan`、`reminder`、`settings` 已采用云端安装依赖方式部署，状态均为 `Active`。
- `reminder` 仅声明 `subscribeMessage.send` 云调用权限；`reminderTimer` 的类型和 Cron 已按清单核对。
- 开发者工具重新编译后问题面板为 0，设置页成功读取家庭设置和提醒状态；该证据不替代真机订阅与实际送达验收。

## 订阅提醒真机验收（进行中）

1. 在微信开发者工具重新编译，确认问题面板没有新增错误。
2. 真机进入设置页，点击“增加 1 次提醒”并接受，确认预计次数增加 1；拒绝授权时通知仍可保存。
3. 创建一条当前用户属于提醒对象、调度时间落在下一触发窗口的测试通知，确认 30 分钟调度窗口内只收到一条消息。
4. 核对模板字段 `thing1`、`time2`、`thing4`、`thing15`、`phrase25` 及北京时间，并确认点击消息进入对应的只读通知详情页。
5. 验证重复触发不会重复发送，过期、删除、禁用或成员退出后的通知不会补发。等待期间只读检查一次云函数日志和两类记录状态，不手工调用 `run`。

阶段性结果（2026-09-11）：

- 真机已接受待办模板的一次性订阅授权，设置页曾显示预计可用次数为 2；该数字是服务端保守估算，不代表微信提供的真实余额。
- 已创建一条仅包含单一目标关系的开发环境测试通知，提醒时间为北京时间 14:20，提前量为 120 分钟；发送任务仅由 `reminderTimer` 自然触发，未手工调用 `run`。
- 自然调度后预计可用次数由 2 降至 1，`pendingCount` 为 0；`reminder_deliveries` 中唯一记录为 `sent`，`attemptCount` 为 1、无错误且授权扣减已最终确认。
- 后续两个触发窗口后记录总数仍为 1，本次真实场景未发生重复发送。
- 云函数日志服务当前未启用，因此未为获取历史日志而临时开启可能增加资源消耗的服务；本次以客户端状态和数据库记录交叉核验。
- 仍待用户确认手机实际收件、模板字段和北京时间显示，以及点击消息进入对应只读详情页；在这些结果确认前不得宣称实际送达闭环完成。

## 免费资源观察与回退（尚未执行）

- 部署时记录时间、九个函数状态、触发器状态和真机送达结果；部署后在云开发控制台观察调用次数、资源点、扫描数量、发送成功数、等待订阅数和错误码分布，不记录消息正文或完整 OpenID。
- 30 分钟频率约每月触发 1440 次。若免费资源点异常增长，把 Cron 降为每小时一次 `0 0 * * * * *`，并重新核对触发器状态。
- 出现模板字段错误、误发风险或无法解释的发送增长时，先停用 `reminderTimer`；保留 `message_subscriptions`、`reminder_deliveries` 和历史审计记录，不删除数据。
- 微信返回 `43107` 后，服务会把对应订阅记录的 `blockedReason` 固定为 `SYSTEM_BLOCKED`，后续候选任务直接进入 `failed`，不再扣减预计次数或调用发送接口。客户端和 `recordSubscription` 均不得清除此状态。
- 只有管理员确认订阅消息模板和发送能力已经恢复后，才能在云开发控制台显式清除对应 `message_subscriptions.blockedReason`，再观察后续新任务是否恢复发送；不得同时增加预计次数或把既有 `failed` 任务改回待发送。若再次出现 `43107`，立即停用 `reminderTimer` 并继续排查平台能力。
