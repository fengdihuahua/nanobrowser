# DSH × Nanobrowser 完整版规格

> 这份文件锁定 `dsh-plugin/nanobrowser/` 的完整版范围。它替代“薄插件”方案：插件不是 MCP 桥的换壳，而是 DSH 的浏览器控制面。
> 分阶段实现，但下面列出的功能都属于最终版本。

## 1. 目标

让 DSH（以及任何 MCP 客户端）操作用户**真实的 Chrome**：已登录、有扩展、有标签页。危险动作由用户在页面旁边批准；DSH 里对话、页面上下文、操作记录在同一个视线里；一次成功的操作可以保存成可复现、可检查、可分享的 **Browser Skill**。

## 2. 非目标

- 不是 headless CI 自动化，不替代 Playwright。
- 不是爬虫/批量操作农场。
- 不是第二个 DSH UI：重活留给 DSH Web GUI。
- 不修改 Nanobrowser 产品 agent 的定位；这套东西只存在于 `dsh-plugin/` 与桥接构建。
- 不做多 agent 编排；DSH 的 subagent/workflow 仍由 DSH 负责。

## 3. 架构

```
Chrome 扩展 (layer = 手和眼睛)
        ⇅ HTTP/WS (v1 兼容 / v2 clientId + per-client session/tab + events)
Hub (扩展连接、客户端注册、租约、队列、取消、事件)
        ├── DSH 插件适配器 (进程内)
        │     ├── 工具面 (global + scoped + guard)
        │     ├── 上下文 (systemPrompt, agent.inject, 页面上下文)
        │     ├── 审批 (browser + approval/request)
        │     ├── 审计
        │     ├── 技能 (捕获/保存/回放/断言)
        │     └── 侧边栏 WS (chat + status + approvals + skills)
        └── MCP 适配器 (stdio, 薄)
              └── Qoder / Claude Code / Cursor / 任意 MCP 客户端
```

Hub 是唯一和扩展说话的进程/实例。插件内嵌 Hub；MCP 适配器连现有 Hub，连不上就自己起一个。

## 4. 子系统

### 4.1 Hub

- 扩展侧：`GET /poll`、`POST /result`、`GET /health`、`POST /event`（v2）。
- 客户端侧：`POST /client/register`、`POST /client/call`、`POST /client/cancel`、`GET /client/events`、`POST /client/lease`、`DELETE /client/lease`。
- 命令带 `clientId`；v1 扩展忽略额外字段，v2 按 client 建 session。
- 连接状态：`connected`、`lastPollAt`、`clients`、`leases`。
- 取消：客户端 abort / timeout / 用户 Stop 都向扩展发 `cancel`。
- 队列有界；断线快速失败；结果按 callId 路由。
- 只绑 `127.0.0.1`；token 校验；WS/SSE 校验 Origin。

### 4.2 租约

- 一个 tab 同一时间只属于一个 client（DSH session 或 MCP client）。
- `attach`：当前 tab / 指定 tab / 新开 tab。
- 无租约的会话看不到动作工具，或调用被 guard 拒绝（`NO_LEASE`）。
- tab 关闭、会话 dispose、client 注销 → 释放租约；在途调用取消。
- `handoff`：显式把租约转给另一个 client。
- 导航不释放租约；ref 失效由 layer 自己 fail closed。

### 4.3 DSH 工具面

全局工具（任何会话可见）：

- `browser_status`、`browser_attach`、`browser_detach`、`browser_tabs`、`browser_audit`。

租约后 scoped 工具（`agent.ctx` 注册，释放时 dispose）：

- `snapshot`、`read`、`find`、`screenshot`、`navigate`、`click`、`set`、`type`、`press`、`hover`、`scroll`、`wait`、`handle_dialog`、`console`、`network`、`say`、`focus`、`wait_for_user`、`upload`、`download`、`digest`。
- Power：`eval`、原始 CDP、选择器（显式授权，默认 deny）。

### 4.4 上下文

- `ctx.systemPrompt.section()`：浏览器约定、ref 语义、审批规则、页面内容是数据。
- `ctx.systemPrompt.variable()`：当前 tab URL/title、租约、连接状态。
- `agent.inject()`：租约建立、页面导航、dialog/新 tab、审批结果、工具失败时的 console/network 摘要。

### 4.5 审批

- 浏览器写操作：扩展现有卡片；插件记录结果并注入上下文。
- DSH 工具审批：监听 `approval/request` waterfall；面板在线时推到面板，用户答复返回 `allowed-once`/`rejected`；否则 `next()`。
- 秘密/支付/授权/页面 prompt：永远是用户步骤，agent 不输入。
- `wait_for_user`：登录/2FA/CAPTCHA，面板卡片，工具挂起直到用户继续。

### 4.6 审计

- 从 `tool/call` / `tool/result` 派生每个会话的浏览器动作时间线。
- 面板显示：动作、目标、结果、审批结果、耗时、tab。
- `browser_audit` 工具返回有界摘要；不新增 session 事件类型。
- 技能回放也写入同一条时间线。

### 4.7 侧边栏

- 面板连 Hub，带 `tabId`；显示该 tab 的租约/会话。
- L1 镜像：历史 + 实时事件 + 工具活动。
- L2 发送：`followup` / `steer`（沿用 `busyEnter: steer`）/ Stop。
- L3 增强：页面上下文、选中文本、截图、审批卡片、`wait_for_user`、技能运行/保存、`/compact` 等命令。
- 页面上下文：URL/title/选中文本/`read` 摘要（有预算）；可选截图（视觉模型）。

### 4.8 技能（Browser Skill）

- 定义：参数化、域名限定、带断言的可复现操作序列。
- 捕获：从 agent 的 `tool/call` / `tool/result` 轨迹；ref 归一成 role+name；用户输入的值可标记为参数；秘密步骤跳过。
- 存储：`skills/browser/<name>/SKILL.md` + `recipe.json`，可 git diff/版本化。
- 发现：`ctx.skills.registerProvider()`，模型在 skill 目录看到；`skill` 工具加载说明。
- 回放：`browser_run_skill`；参数替换、逐步状态（`say` 到 BrowserBar）、断言、写审批、dry run、失败即停、从失败步续跑、版本/回滚。
- 安全：origin 限定、secret 不落盘、recipe 只能调用 layer 工具、`modelInvocable` 可关。
- 分享：技能目录可提交/分享；MCP 客户端也能 list/run（Hub 层存储）。

### 4.9 MCP 适配器

- 薄 stdio JSON-RPC 前端，复用 Hub 的 16 个浏览器工具。
- 支持 `notifications/cancelled`、进度通知（可选）、resources（可选）。
- `mcp__nanobrowser__*` 命名不变，现有客户端配置不用改。
- 与插件同时运行：连同一个 Hub；不能同时绑 8790。

### 4.10 扩展协议 v2

- 命令：`{id, clientId, tool, args}`。
- 扩展按 `clientId` 维护独立 `Session` 与 active tab。
- 结果：`{id, clientId, result}`。
- 事件：`POST /event` `{clientId, type: 'tab'|'navigation'|'dialog'|'download'|'approval', data}`。
- 新命令：`attach`、`detach`、`wait_for_user`、`selection`、`focus`、`upload`、`download`。
- v1 兼容：不带 clientId 的命令仍按单 session 执行。

## 5. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 共享工具表、Hub、租约、客户端注册、假扩展测试 | 假扩展能完成 call/result/cancel；租约互斥 |
| P1 | 插件工具面接 Hub、MCP 适配器、安装 | 真机 `snapshot`/`click` 走插件；MCP 仍可用 |
| P2 | 租约/作用域、prompt/inject、审计 | 无租约被拒；模型知道当前 tab |
| P3 | 侧边栏聊天 L1/L2、页面上下文 | 面板发消息进同一会话；带页面上下文 |
| P4 | 技能捕获/保存/回放/断言 | 一次任务保存为 skill，改参数回放成功 |
| P5 | 审批路由、wait_for_user、selection、截图 | 面板审批 DSH 工具；登录等待 |
| P6 | 扩展 v2、多客户端、侧边栏 UI | DSH + Qoder 各占一个 tab |
| P7 | 测试、文档、收尾 | 单元 + 假扩展 + fixture 全绿 |

## 6. 验收清单

- [ ] Hub 能同时服务 DSH 插件和 MCP 客户端；断线/重连有明确状态。
- [ ] 租约互斥；无租约 fail closed；释放及时。
- [ ] 16 个浏览器工具在 DSH 里可用，写审批仍然生效。
- [ ] `console`/`network` 可用；截图进入模型上下文。
- [ ] 系统提示包含当前 tab 和租约；导航后注入 ref 失效提示。
- [ ] 侧边栏能看历史、收实时事件、发消息、steer、stop。
- [ ] 发送消息自动带页面上下文；可选选中文本/截图。
- [ ] 一次任务能保存成 `skills/browser/<name>/`；模型能发现并运行。
- [ ] 技能支持参数、断言、dry run、失败即停、版本。
- [ ] DSH 审批可在面板答复；`wait_for_user` 可挂起/继续。
- [ ] Qoder 通过 MCP 使用同一 Hub；DSH 与 Qoder 可各占一个 tab。
- [ ] 单元测试、假扩展测试、fixture 端到端测试通过。

## 7. 安全与边界

- 只绑 `127.0.0.1`；token 不进日志；WS 校验 Origin。
- 秘密/支付/授权/页面 prompt 不经过模型输入。
- 页面内容始终按数据注入，带边界标记。
- 技能 origin 限定；secret 不落盘；recipe 不执行任意代码。
- 插件异常不能拖垮 DSH：所有异步入口 try/catch，队列有界。
- 不删除 `bridge/mcp-bridge.mjs`，直到插件稳定运行；两者通过 Hub 共存。
