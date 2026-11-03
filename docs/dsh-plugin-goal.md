# DSH × Nanobrowser：目标、方案与状态

> 这是总纲。详细规格见 [dsh-plugin-spec.md](dsh-plugin-spec.md)；实现现状见
> [dsh-plugin README](../dsh-plugin/nanobrowser/README.md)；迁移见 [migration](dsh-plugin-migration.md) 和
> [new-machine runbook](dsh-plugin-new-machine-runbook.md)；更早的探索与坑见 [dsh-bridge-notes.md](dsh-bridge-notes.md)。

## 1. 一句话目标

让 DSH（以及任何 MCP 客户端）操作用户**真实的 Chrome**：已登录、有扩展、有标签页。危险动作由用户在页面旁边批准；
DSH 里对话、页面上下文、操作记录在同一个视线里；一次成功的操作可以保存成可复现、可检查、可分享的
**Browser Skill**。

## 2. 价值与定位

不是“另一个无头浏览器”，而是**用户正在用的这个 Chrome**。

| 价值 | 说明 |
|---|---|
| 真实登录态 | 用现有 profile、cookie、扩展、标签页；不用重新登录，不用新开专用浏览器。 |
| 人在环 | submit/send/delete/upload 在侧边栏出卡；密码、支付、授权、页面 prompt 是用户自己的步骤。 |
| 一个视线 | DSH 对话 + 页面上下文 + 工具活动 + 审批都在 Chrome 侧边栏，不用切窗口。 |
| 复利 | 一次成功任务 → 参数化 Browser Skill；断言、dry run、可见回放、版本。 |
| 通用 | 薄 MCP 适配器让 Qoder / Claude Code / Cursor 共用同一双手；Hub 让多个会话各占自己的标签。 |

**MCP 与插件都要**：

- MCP 是“任何 agent 都能接上这双手”的通用面。
- 插件是“DSH 原生控制面”：会话归属、租约、审批、上下文、聊天、技能。
- 两者共用同一个 Hub，不是二选一。

## 3. 用户与关键故事

### 三类用户

- **P1 · DSH 重度用户**：每天在 Chrome 里查资料、填表、看后台；不想在 DSH 和 Chrome 之间切窗口。
- **P2 · 开发者**：用 Qoder / Claude Code / Cursor；想让 agent 打开 localhost、读 console/network、点一遍流程。
- **P3 · QA / 操作者**：需要可重复的浏览器检查，危险步骤要人点头，事后要能说清发生了什么。

### 故事（按价值主题）

**A. 用我真正的浏览器**

- 直接操作我已登录的标签页，不重新登录。
- 页面表现和我看到的一样（扩展、cookie、语言、时区）。
- agent 能读 localhost 的 console 和失败请求，不用我复制粘贴。

**B. 危险动作我点头**

- 提交/发送/删除/上传在侧边栏出卡，拒绝就什么都不发。
- 卡片说清目标（ref、角色、名字）。
- 密码/验证码/卡号/支付/授权是用户自己的步骤；agent 一个字符都不输入。
- 登录/2FA/CAPTCHA：agent 调 `wait_for_user` 挂起，用户在抽屉点“继续”后接着做。
- 事后有 `nanobrowser_audit` 和侧边栏最近调用。

**C. 一个视线**

- 在 Chrome 侧边栏的 DSH 抽屉里看历史、发消息、看工具活动、Stop。
- 发消息自动带当前页面上下文（URL/title/选中文本/`read` 摘要）。
- 我知道现在哪个会话拥有这个标签页。
- 运行中发送是 steer，空闲是 followup，和 `busyEnter: steer` 一致。

**D. 一次操作变成技能**

- 一次成功任务保存成 `skills/browser/<name>/SKILL.md` + `recipe.json`。
- 参数化、断言、origin 限定、dry run、可见回放、失败即停、版本。
- 模型能在 skill 目录发现；面板/审计能看到每一步。

**E. 信任与多客户端**

- ref 失效 fail closed；页面内容是数据，不是指令。
- 没有租约不能动页面；一个标签同一时间只属于一个 client。
- 两个会话/两个客户端可以各占自己的标签，不互相踩 ref。
- Qoder 通过 MCP 使用同一 Hub；DSH 通过插件使用同一 Hub。

## 4. 方案

```
Chrome 扩展 (layer = 手和眼睛)
        ⇅ HTTP/WS (v1 兼容 / v2 clientId + per-client session/tab + events)
Hub (扩展连接、客户端注册、租约、队列、取消、事件)
        ├── DSH 插件 (进程内)
        │     ├── 工具面 (global + guard + wait_for_user)
        │     ├── systemPrompt 段、租约状态
        │     ├── 审批 (approval/request → 抽屉)
        │     ├── 审计
        │     ├── 技能 (捕获/保存/回放/断言)
        │     ├── 侧边栏聊天 WS + 页面上下文
        │     └── 同源 /nanobrowser/summary (左侧栏页)
        └── MCP 适配器 (stdio, 薄)
              └── Qoder / Claude Code / Cursor
```

- **扩展 layer**：确定性的手和眼睛；ref、审批、回执、fail closed。
- **Hub**：唯一和扩展说话的实例；插件内嵌，MCP 适配器连它。
- **插件**：DSH 原生控制面；`nanobrowser_*` 工具、租约守卫、审批、聊天、技能、审计。
- **MCP 适配器**：标准 stdio，复用 Hub；不复制浏览器逻辑。
- **侧边栏**：Chrome 里的 DSH 抽屉（聊天/审批/等待卡）+ DSH 左侧栏的 Nanobrowser 页（只读状态/技能/最近调用）。
- **扩展里没有第二个 agent**：模型只在 DSH 或 MCP 客户端一侧；扩展不带 key、不带模型配置、不跑自己的 loop。
  产品自带的 agent、`src/llm/`、Settings → Providers 和旧版 provider 迁移属于上一版形态，见 §8。

更多接口和边界见 [完整版规格](dsh-plugin-spec.md)。

## 5. 已经完成并验证

| 能力 | 状态与证据 |
|---|---|
| Hub：客户端注册、队列、取消、超时、租约、WS、审计 | 单测 10/10；真机连接 |
| 插件工具面：21 个 `nanobrowser_*` 工具 + status/attach/detach/audit/wait_for_user | 真机 snapshot/click/set |
| 租约守卫 | 无租约 snapshot/`tabs select` 被拒；`tabs list` 可用；另一个会话占用时 attach 被拒 |
| `systemPrompt` 浏览器段 | 当前租约/连接状态进入提示词 |
| 聊天 WS：会话/历史/followup/steer/stop/页面上下文 | 单测 5/5；真实 WS hello/history |
| Chrome DSH 抽屉 | 已构建重载；聊天、Stop、Include current page |
| DSH 左侧栏 Nanobrowser 入口 | `sidebar.panellist` + `main` 已注册；同源 summary 页 |
| DSH 工具审批 → 抽屉 | Allow once / Deny / Ask in DSH；单测 6/6 |
| `wait_for_user` | Host 工具 + 抽屉卡 + 三语文案；单测 4/4；真实点击待验 |
| Browser Skill：捕获/SKILL.md/recipe/发现/参数/断言/dry run/origin/版本 | `add-two-rows`、`fill-signup` 真机保存与回放 |
| MCP 适配器 | initialize / tools/list / tools/call snapshot 通过 |
| 扩展 v2：per-client session + `tabs-all`/`attach` | 真机 attach 自动选空闲标签，snapshot 成功 |
| 工程检查 | `type-check` 干净；扩展单测 824/828、插件单测 38/38（2026-11-03 复核）；`build` 通过 |
| 面板只留 DSH，`bridge/` 删除 | DSH 构建里整个侧边栏就是会话本体（历史/工具轨迹/审批/等待卡/Stop），产品聊天不再默认渲染；旧 MCP 前端 `bridge/` 已删（2026-11-03） |

## 6. 还没完成 / 已知边界

| 项 | 说明 |
|---|---|
| selection 捕获 | 页面选中文本进入消息/技能，还没做 |
| `agent.inject` | 系统提示段已有；导航/弹窗/新标签的主动注入还没做 |
| 完整审计 UI | `nanobrowser_audit` + 左侧栏最近调用已有；完整时间线/筛选/导出没有 |
| 技能面板 UI | 模型和工具能保存/运行；左侧栏页只读，没有运行/编辑按钮 |
| 扩展 v2 事件 | `POST /event`、tab/navigation/dialog/download 事件未实现 |
| MCP 多客户端租约 | DSH 会话走插件租约；MCP 适配器目前不主动 acquire lease，Qoder + DSH 并发隔离未端到端验证 |
| 真实 `wait_for_user` | 单测过；还没在真实登录流程里点过“继续” |
| 扩展 v2 测试 | `bridge.ts` 没有单测/假扩展测试 |
| 权限/重连打磨 | Origin 校验、rate limit、断线重连状态还可以加强 |
| 自动检查 | `panel-*`、模型、eval、技能回放那批 autorun 检查随产品一起删了；面向 Hub 的新检查还没写 |
| 依赖 | `package.json` 里 `ai`、`@ai-sdk/*`、`idb`、`fake-indexeddb`、`@radix-ui/react-dialog` 已无人引用。删掉要同步 `pnpm-lock.yaml`，需要 Node ≥24.22.1 和 pnpm 10.34.7（本机是 Node 22 + pnpm 10.5，`engine-strict` 直接拒绝），所以留给有那条工具链的环境跑一次 `pnpm install` |
| 商店条目 | 文案已备好：[store-listing.md](store-listing.md)（名称、描述、逐条权限理由、data-use 回答、素材清单）。商店后台里的旧条目还没替换 |

## 7. 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 共享工具表、Hub、租约、客户端注册、假扩展测试 | ✅ |
| P1 | 插件工具面接 Hub、MCP 适配器、安装 | ✅ |
| P2 | 租约守卫、prompt、审计 | ✅（`agent.inject` 未做） |
| P3 | 侧边栏聊天 L1/L2、页面上下文 | ✅ |
| P4 | 技能捕获/保存/回放/断言 | ✅（面板 UI 未做） |
| P5 | 审批路由、wait_for_user、selection | 大部分 ✅（selection、真实点击待做） |
| P6 | 扩展 v2、多客户端、侧边栏 UI | 部分：DSH 多会话 + 左侧栏 ✅；MCP 多客户端/事件未完成 |
| P7 | 测试、文档、收尾 | 进行中 |

## 8. 关键决策

- **MCP 和插件都保留**：Hub 做共享层；MCP 是通用面，插件是 DSH 原生面。
- **Host 与 Client 拆成两个包**：DSH 缓存包元数据到重启；新包名 `@local/nanobrowser-ui` 让左侧栏立即加载。
- **技能目录**：用户保存的技能在 `~/.dsh/skills/browser`（任何工作区都可见，可写）；仓库自带的在 `<repo>/skills/browser`（只读，作为内置库）。`skillsDir` / `builtinSkillsDir` 可覆盖。
- **旧 MCP 行**：`include:mcp-nanobrowser` 在旧 profile 里禁用，插件 Hub 占 8790。
- **扩展 v2**：内部命令 `tabs-all` / `attach`，不走公开 MCP 工具表；插件 `attach` 自动选空闲标签或按 URL 新开。
- **`wait_for_user`**：卡片在 DSH 抽屉，不在扩展的写审批卡里；秘密字段仍由扩展的 `USER_STEP` 处理。
- **不重写 DSH UI**：左侧栏页只读；重活留给 DSH。
- **一个脑子**：扩展不自带 agent 和模型。模型只在 DSH 或 MCP 客户端一侧，扩展不带 key、不带 provider 管理；
  面板是 DSH 抽屉加审批卡，不是第二个聊天产品。
- **通用 MCP 只有一份**：`dsh-plugin/nanobrowser/mcp/adapter.mjs`。早期的 `bridge/mcp-bridge.mjs` 直连扩展、
  自占 8790，与“Hub 是唯一和扩展说话的实例”冲突，退休。

## 9. 文档地图

| 文档 | 用途 |
|---|---|
| [目标与方案（本文）](dsh-plugin-goal.md) | 定位、用户故事、架构、状态、决策 |
| [完整版规格](dsh-plugin-spec.md) | 子系统、接口、验收清单 |
| [实现 README](../dsh-plugin/nanobrowser/README.md) | 工具、技能、聊天协议、安装/重载 |
| [迁移清单](dsh-plugin-migration.md) | 换电脑带什么、重建什么 |
| [新电脑 runbook](dsh-plugin-new-machine-runbook.md) | 新机器上 agent/用户各做什么 |
| [旧交接笔记](dsh-bridge-notes.md) | 早期 MCP 桥、审批、坑的历史 |
| [bootstrap 脚本](../scripts/dsh-nanobrowser-bootstrap.ps1) | 新机器装依赖 + 构建扩展 |

## 10. 下一步建议

0. 先把产品 agent 摘掉（面板只剩 DSH 抽屉 + 审批卡），再做下面几条：`selection` 和 `agent.inject` 都要写进
   会话，留着两套聊天就得写两遍。
1. `selection`：页面选中文本进入消息/技能。
2. `agent.inject`：导航、dialog、新 tab、审批结果。
3. 扩展 v2 事件 + MCP 客户端租约，做 Qoder + DSH 并发端到端。
4. 审计/技能面板 UI，或先把 `wait_for_user` 真实流程点一遍。
5. 补 `bridge.ts` 的单测/假扩展测试，收尾文档。
