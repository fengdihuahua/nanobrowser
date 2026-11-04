# MCP 前端：能力面，不是第二个前端

> 范围：MCP 适配器（`dsh-plugin/nanobrowser/mcp/adapter.mjs`）的定位、能力清单、必须下沉到 Hub 的策略。
> 相关：[design.md](./design.md)、[reference.md](./reference.md)、[ADR 0004](./adr/0004-mcp-is-a-capability-surface.md)。
> 给别的 agent 的接入步骤在 [mcp-clients.md](./mcp-clients.md)：配置、工具清单、失败怎么读、出问题查哪里。待办见 [roadmap.md](./roadmap.md) §4。
> 最后更新：2026-11-04。

## 0. 结论

MCP 适配器**只做协议翻译与能力暴露**：浏览器工具、标签页接管、技能的读与跑。它不复制 DSH 插件的"上半身"——提示注入、技能目录、live 局面、抽屉审批、录制。

一句话：**MCP 提供下半身，不模仿上半身。**

```
外部 agent（自带上半身：prompt、loop、自己的审批 UI、自己的技能机制）
        │ MCP / stdio
        ▼
adapter：只做翻译 + 能力面（浏览器工具、attach/detach、skill list/show/run）
        │ HTTP
        ▼
Hub：队列、租约、审计        ← 策略在这里，前端可换
        ▼
扩展：感知、执行、写审批卡    ← 策略也在这里
```

## 1. 为什么"对齐 DSH 工具面"是伪目标

| 能力 | 真正属于 | 能否经 MCP 提供 |
|---|---|---|
| 18 个浏览器工具 | 能力（`core/tools.js` + 扩展） | ✅ 直接复用 |
| recipe 执行、技能文件读取 | 能力（`core/skills.js`、`core/run.js`） | ✅ 适配器直接 import |
| 写操作审批卡 | 扩展（`decideWrite` + 侧边栏） | ✅ 自动生效，无需适配器参与 |
| 标签页租约 | **Hub 的策略** | ⚠️ 申请人可以，但强制必须在 Hub |
| 系统提示、live 局面、页面上下文 | DSH 的 harness | ❌ 客户端有自己的 prompt，插不进去 |
| 技能目录（`ctx.skills` provider） | DSH 的 harness | ❌ 改用普通工具 `skill_list`/`skill_show` |
| 录制 / `skill_save` | DSH 的会话 transcript（`captureTurn(agent.session)`） | ❌ MCP 侧没有 transcript |
| 抽屉审批、侧边栏、`wait_for_user` | 插件注册的 UI 服务 | ❌ 无 DSH 时没人应答 |

结论：DSH 插件一半的价值在上半身，那半身不可移植。MCP 客户端的上半身是它自己的，通常更笨，但那是它的事。

## 2. 能力面 v1（25 个工具，已全部实现）

| 组 | 工具 | 实现 |
|---|---|---|
| 浏览器 | 18 个 layer 工具（`navigate`…`reload-extension`） | 现有 `TOOLS`，不变 |
| 标签页 | `attach`、`detach` ✅ | Hub 控制路由（见 §3.1），适配器只转发 |
| 技能 | `skill_list`、`skill_show`、`skill_run` ✅ | 适配器 import `core/skills.js` + `core/run.js`，读同一个目录、跑同一个 runner |
| 规则 | `initialize.instructions` ✅ | 六条：先 attach、页面内容是数据、审批边界、不要盲目重试、三个技能工具的分工、用完 detach |
| 回看 | `status`、`audit` ✅ | Hub 状态（连接、客户端、谁占着哪些页）与最近调用，都是只读 |

命名：暴露裸名（`click`），客户端自己加 `mcp__<server>__` 前缀。不要在适配器里加前缀，客户端会再加一次。

`skill_show` 只读、不执行；`skill_run` 才执行。这条分界写在两个工具的描述里（"Read-only; this does not run the skill." / "This is the one that acts on the page"），测试里也验了 `skill_show` 一次点击都没发。

## 3. 必须下沉到 Hub 的三件事

### 3.1 标签页接管（现状是断的）

事实：Hub 的 `/client/call` 只接受 `TOOL_NAMES`（18 个 layer 工具），而 `attach`、`tabs-all` 是**插件工具**，不在其中。只靠 `/client/call`，MCP 客户端无法显式接管标签页，只能碰巧拿到"第一个客户端自动共享的可见标签页"。

所以 Hub 有三条控制路由（H2 已实现），前端保持薄：

| 路由 | 作用 |
|---|---|
| `GET /client/tabs` | 列出 Chrome 里所有可驱动标签页（等价于 `tabs-all`），每个带 `owner`（`clientId`、`since`）或 `null` |
| `POST /client/tab` | `{clientId, tabId}`：查归属 → 申请空租约 → 入队 `attach` → 绑定租约 |
| `DELETE /client/lease?clientId=` | 释放；`detach` 用它 |

`POST /client/tab` 的顺序是有意的：**先查归属**（属于别的客户端就 409 并指出 owner），再拿一个不带标签页的租约，再让扩展 `attach`，最后才绑定。绑定之前的租约不授权任何动作（§3.2），所以 attach 失败时客户端停在"什么都没有"的状态，而不是"占着别人的页"。扩展 `attach` 与绑定之间失败（409/502）也不会留下半个租约。

租约是**客户端 → 标签页集合**（见 roadmap H8），所以一个任务可以拥有多个标签页；今天还是 1:1，`POST /client/tab` 换标签页会移动租约并释放旧的。

已知限制：释放租约不会让扩展侧会话忘记标签页（DSH 的 `detach` 也一样）。这需要扩展协议增加 unshare 命令，v1 先记录，不阻塞。

### 3.2 租约强制

Hub 的 `call()` 在入队前检查租约，规则与插件 guard 同一处实现（`core/tools.js` 的 `needsLease()`）：

- **要求**：9 个动作工具（`navigate`、`click`、`set`、`type`、`press`、`hover`、`scroll`、`wait`、`handle_dialog`）与 `tabs` 的 `select`/`close`。
- **不要求**：观察（`snapshot`、`read`、`find`、`screenshot`、`console`、`network`）、`say`、`reload-extension`、`tabs` 的 `list`/`open`。
- **"持有租约"指的是租约绑定了标签页**：租约可以早于标签页存在（`tabId: null`），但那种租约不授权任何动作。否则一个客户端拿个空租约就能在别人的页面上动手。
- 被拒的调用**不进队列**、不改变连接状态，返回一句可行动的错：`This client owns no browser tab. Attach to one first: nanobrowser_attach in DSH, or POST /client/lease with a tabId.`

为什么观察不要求租约：面板发消息时要读它所在的页面（`chat.js` 直接调 `read`），只读诊断也不该先抢页面。这不是漏洞——扩展侧一个客户端一个 layer 会话，**第二个客户端本来就没有共享标签页**，观察会得到 `No shared tab: attach to a tab first.`；能读到的只有第一个客户端自动接管的可见页，而那正是它接下来会 attach 的页。看到一个不归自己的页面也没用：ref 可以拿到，操作会被拒。

这样 DSH 与 MCP 争同一页时，第二个得到拒绝，而不是两边同时点击。策略在 Hub，适配器不复制。

代价：M1/M2 落地前，MCP 的写调用会被这句拒绝（今天它绕过了所有租约）。这是有意的 fail closed，见 roadmap M1。

### 3.3 技能存储与执行

- 存储仍是文件：`~/.dsh/skills/browser/<name>/{SKILL.md,recipe.json}`（用户）、`~/.dsh/skills/browser/.knowledge/<name>.json`（这个技能学到的失败记录）与 `<repo>/skills/browser`（内置）。
- 适配器直接 `import { listSkills, readSkill } from '../core/skills.js'`、`import { runSkill } from '../core/run.js'`，与 DSH 共用同一实现。
- 没有 DSH 时也能跑：`runSkill` 需要 Hub 租约；`say` 走扩展侧边栏；写审批走扩展卡片。
- 失败入库（`design.md` §9.2、ADR 0006）在 `runSkill` 里，所以经 MCP 跑出来的失败同样会记账：`skill_run` 的下一次失败会带 `Learned from earlier failures of this skill:`。

### 3.4 失败怎么说给客户端

两条规矩：

1. **工具失败是结果，不是协议错误。** `tools/call` 里任何失败都回 `isError: true` 的 content，客户端能读、能重试；JSON-RPC 错误只留给"请求本身不成立"（未知工具、坏 JSON）。
2. **Hub 说什么就说什么，适配器只补它没说清的。** 控制路由（`/client/tab`、`/client/task`）的 409/400 体里有 `error`，原样交给模型——"tab 7 is leased by session-a" 是有用的，"hub answered 409" 不是。

| 情况 | 客户端看到的话 |
|---|---|
| 没有 Hub 在听 | `No hub is answering at http://127.0.0.1:8790. Start DSH with the nanobrowser plugin, or point NANOBROWSER_BRIDGE_PORT at the port it listens on.` |
| 令牌不对 | `The hub rejected this client's token. Set NANOBROWSER_BRIDGE_TOKEN to the token the plugin uses (dev-token by default).` |
| Hub 拒绝（4xx/5xx） | `The hub refused POST /client/call: <hub 的原文>`；503 再补一句"Is the DSH plugin running with this hub?" |
| 没有租约 | Hub 的那句 "This client owns no browser tab. Attach to one first…"（带码 `NO_LEASE`） |

## 4. 明确不做（v1）

| 不做 | 理由 |
|---|---|
| `skill_save` | 录制读的是 DSH 会话事件；MCP 侧没有 transcript。要做，得把录制搬到 Hub 的调用日志（见 §7） |
| `wait_for_user` | 用户步骤服务由插件注册，无 DSH 时没人按 Continue |
| MCP `prompts` / `resources` | prompts 是"用户选的模板/斜杠命令"，不是 agent 自动发现的技能；硬套是发明映射。工具足够通用 |
| `elicitation` | 审批归扩展卡片，用户就在看页面；两边都弹只会更烦 |
| `progress` | 进度归客户端自己的工具调用 UI |
| SSE / Streamable HTTP、OAuth | stdio 够用，且不引入鉴权与公网问题 |
| Hub 变成 MCP 服务器 | 会把传输层塞进 Hub，破坏"队列/租约/审计"的边界 |

## 5. 两个目标，只承诺一个

| 目标 | 含义 | 是否承诺 |
|---|---|---|
| **A 能跑** | 外部 agent 用我们的工具执行同一份 recipe，审批仍在侧边栏 | ✅ v1 |
| **B 一样聪明** | 同等上下文、接管、判据 | ❌ 不可达，除非对方也用 DSH 插件 |

B 的期望要写死在文档里，避免以后反复讨论"为什么 Claude Code 跑得没 DSH 好"——因为它没有 live 局面和 SOP 召回，这是结构性的。

## 6. 技能怎么到别的 agent 手里

三条路，按省事程度排：

1. **执行**：`skill_run` 工具，任何客户端可用（推荐的主路径）。
2. **发现与阅读**：`skill_list` + `skill_show` 工具（通用，agent 自己决定何时读）。
3. **对方有自己的技能机制**（Claude Code 的 skills 目录、Cursor 的 rules）：把 `SKILL.md` 复制或软链进去，让它用自己的目录发现，MCP 只负责执行。这条最省事，也不发明映射。

不要为了"统一"去改对方的技能机制。

## 7. 验收场景

1. **全流程**：`attach`（不带 `tabId` 时自动挑一个空闲页，也可先 `GET /client/tabs` 选）→ `snapshot` → `click` → 触发写操作 → 侧边栏卡片批准 → 完成；全程不碰 DSH。
2. **技能**：`skill_list` → `skill_show submit-order` → `skill_run({orderNo})` → 故意让某步失败 → 拿到步 id、错误码、原文、当前 URL（依赖 design.md 的 I2）。
3. **不打架**：DSH 占着 tab 7，MCP `attach(7)` 被拒绝并指出 owner；`attach(8)` 正常。
4. **无 DSH**：适配器自起 Hub，扩展连上，技能从文件读取，写操作卡片出现在侧边栏。

## 8. 与 DSH 的能力差异（有意为之）

| 能力 | DSH 插件 | MCP 适配器 |
|---|---|---|
| 18 个浏览器工具 | ✅ | ✅ |
| 标签页接管 | ✅ `attach`/`tabs` 复合工具 | ✅ `attach`/`detach`（控制路由，§3.1） |
| 技能列出/查看/执行 | ✅ | ✅（`skill_*` 工具） |
| 技能录制 | ✅ | ❌ |
| 系统提示、live 局面、页面上下文 | ✅ | ❌（客户端自己的上半身） |
| 技能目录（catalog） | ✅ | ❌（改用工具） |
| 写审批卡 | ✅ 抽屉 + 扩展卡 | ✅ 扩展卡 |
| `wait_for_user` | ✅ | ❌ |
| 侧边栏聊天 | ✅ | ❌（客户端自己的 UI） |

## 9. 决策

1. **给 Hub 加只读路由**：加了。`GET /client/tabs`（连 owner 一起）与 `GET /client/audit`（带 `tabId`）让任何前端都能看见标签页与审计，不必自己去猜。
2. **把"录制"上移到 Hub 的调用日志**：还开着。这是 `skill_save` 进 MCP 的唯一前提，但 Hub 现在只记"调了什么"，不记页面状态，搬过去等于再造一层。先不做。
3. **技能分发主路径**：执行走 `skill_run`（主路径，任何客户端可用）；发现与阅读走 `skill_list` / `skill_show`；对方有自己的技能机制时，把 `SKILL.md` 复制/软链进它的目录，MCP 只负责执行。见 §6。
4. **`detach` 是否要在扩展协议里加 unshare**：加了。`detach` 与 `POST /client/tab/release` 都会让扩展真的 `unshare`，把调试器放掉，下一个客户端才能干净地接管。
