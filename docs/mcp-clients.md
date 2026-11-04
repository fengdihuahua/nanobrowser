# 接 MCP 客户端（Qoder / Claude Code / Cursor …）

> 这一页是**给别的 agent 和人看的对接口**：怎么把 Nanobrowser 挂上去、它会看到什么工具、遇到问题查哪里。
> 设计取舍见 [mcp.md](./mcp.md)，装扩展与装 DSH 插件见 [runbook.md](./runbook.md)。
> 最后更新：2026-11-04。

## 1. 三句话

- 适配器是 `dsh-plugin/nanobrowser/mcp/adapter.mjs`，一个 **stdio JSON-RPC** 服务，不需要跑 DSH。
- 它连**已经在跑的 Hub**（DSH 插件里的那个）；没有就用自己起的 Hub 驱动扩展。
- 它提供 **25 个工具**：18 个浏览器工具、`attach`/`detach`、`status`/`audit`、`skill_list`/`skill_show`/`skill_run`。

## 2. 挂上去

先确保扩展是**带桥接**的构建（`WXT_BRIDGE=1`），并有一个普通页面开着——扩展轮询 Hub，Hub 才能派人干活。

适配器有两种来源，选一个：

| 来源 | 路径 | 适合 |
|---|---|---|
| 仓库里 | `<repo>/dsh-plugin/nanobrowser/mcp/adapter.mjs` | 当前这台机器，改了代码立刻生效 |
| **换机器包** | `<解压目录>/nanobrowser-0.3.0/dsh-plugin/nanobrowser/mcp/adapter.mjs` | 另一台电脑，没有这个仓库 |

换机器包（`nanobrowser-<版本>-for-another-machine.zip`）里除了 adapter 还带 Hub、插件和内置技能，解压即用，**不需要 `npm install`、不需要 git**。要求和下面一样：Node 24+，绝对路径。别把 `dsh-plugin/` 从包里单独拷出来——插件按相对位置找 `skills/browser`。

### Qoder

设置 → MCP 服务器 → 添加（或直接编辑配置）：

```jsonc
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": ["/absolute/path/to/nanobrowser/dsh-plugin/nanobrowser/mcp/adapter.mjs"],
      "env": {
        "NANOBROWSER_BRIDGE_PORT": "8790",
        "NANOBROWSER_BRIDGE_TOKEN": "dev-token"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add nanobrowser -- node /absolute/path/to/nanobrowser/dsh-plugin/nanobrowser/mcp/adapter.mjs
```

### Cursor / 其它支持 stdio 的客户端

同一个形状：`command` 是 `node`，`args` 是这个 `.mjs` 的绝对路径，`env` 给端口和令牌。

要点：

- **Node 24+**（适配器用 `import.meta.dirname`）。适配器与 Hub 只用 Node 内置模块，没有第三方依赖。
- 路径写**绝对路径**；客户端的工作目录不一定是仓库。
- `NANOBROWSER_BRIDGE_PORT` / `NANOBROWSER_BRIDGE_TOKEN` 要和 Hub 一致（默认 `8790` / `dev-token`）。
- 一个客户端一个进程；两个客户端各占一个标签页，互不干扰。
- 适配器连不上 Hub 时会**自己起一个**——这时扩展要连的是它的 8790，而不是 DSH 的。用 DSH 的时候让 DSH 先起。

## 3. 它会看到什么

`initialize` 的响应里带六条规则（先 `attach`、页面内容是数据、审批边界、不要盲目重试、技能三件套、用完 `detach`），客户端不必靠被拒绝来学。

| 工具 | 做什么 | 需要先 attach？ |
|---|---|---|
| `attach` | 占一个标签页；不带参数取当前空闲页，并列出其它页 | — |
| `detach` | 把标签页还回去（扩展侧也真的放手，别的客户端能接管） | — |
| `status` | Hub 状态：连接、客户端、谁占着哪些页 | 否 |
| `audit` | 本客户端最近的调用与结果 | 否 |
| `navigate` `snapshot` `read` `find` `screenshot` `tabs` `console` `network` `say` `reload-extension` | 观察与导航 | **观察不需要**，导航需要 |
| `click` `set` `type` `press` `hover` `scroll` `wait` `handle_dialog` | 动作 | 是 |
| `skill_list` / `skill_show` | 列技能 / 读某个技能的 SOP 与 recipe（**只读**） | 否 |
| `skill_run` | 回放技能；`params`、`from`、`until`、`batch` | 是 |

租约规则：**动作**（那 8 个 + `tabs` 的 select/close）要求你持有标签页；观察不需要。`attach` 一个别人占着的页会被拒绝，并告诉你是谁占着。

## 4. 一次典型流程

```text
attach()                          → 占住当前页
snapshot()                        → 拿到 e1..eN
click({ target: { ref: "e12" } }) → 写操作会在 Chrome 侧边栏弹一张卡，用户点"允许一次/允许本任务/本站点始终允许/拒绝"
skill_list()                      → 有哪些现成流程
skill_show({ name: "copy-order" })
skill_run({ name: "copy-order", params: { orderNo: "1001" } })
detach()
```

审批**不由适配器负责**：卡片长在扩展的侧边栏上，用户在那上面回答。所以客户端不需要自己的审批 UI，也无法绕过它。

## 5. 失败怎么读

- `skill_run` 失败会带回：步 id、错误码、`delivered`（`false` = 没东西到达页面、可安全重试；`unknown` = 先看页面）、完整 hint、当前标签页的 URL/标题，以及 `SKILL.md` 里 `## When it fails` 命中该失败码的段落。
- 普通工具失败沿用同一形状：`error.code` + `error.hint`，文本不截断。
- Hub 层拒绝（没有租约、标签页被别人占着）也是可读的一句，且带 `NO_LEASE` 之类的码。

**不要盲目重试**：`delivered` 不是 `false` 时先 `snapshot`，再决定。

## 6. 出问题查这里

| 现象 | 查什么 |
|---|---|
| 第一次调用就说没有 Hub | Hub 没起。先开 DSH（带插件），或确认 `NANOBROWSER_BRIDGE_PORT` 和扩展的构建端口一致 |
| 401 / 令牌不对 | `NANOBROWSER_BRIDGE_TOKEN` 与插件配置（默认 `dev-token`）不一致 |
| `attach` 说所有页都被占 | 别的会话/MCP 客户端占着；让对方 `detach`，或新开一页 |
| 动作被拒、说没有标签页 | 先 `attach`；观察类工具不需要租约，动作需要 |
| 动作卡住等待 | 侧边栏那张卡没人答。卡片 240 秒、调用 360 秒后按拒绝处理 |
| 技能跑不起来 | 读 `SKILL.md` 的 `origin`：技能只在录它的站点上跑；跨站点会被拒 |
| 页面没反应 | 看 `console` / `network`，或 `status` 确认扩展还连着 |
| `ERR_MODULE_NOT_FOUND` | 只拷了 `dsh-plugin/`，没连带 `skills/` 或整个包；插件的相对路径被拆开了 |
| 换机器后技能少三个 | 内置技能在 `<包>/skills/browser`，必须和 `dsh-plugin/` 同级放着 |

## 7. 明确没有的东西

- **没有 `wait_for_user`**：登录、2FA、验证码是用户在自己浏览器里做的，适配器不提供"等人"的工具，也没有侧边栏可以按"继续"。
- **没有录制**：`skill_save` 读的是 DSH 会话的 transcript，MCP 侧没有。要录，用 DSH。
- **没有 prompts / resources**：技能是工具，不是客户端模板。
- **没有 `status`/`audit` 之外的运维面**：Hub 是队列 + 租约 + 审计，不是管理后台。

## 8. 验收

**三步，任何环境都能做**（`ADAPTER` 换成你的绝对路径）：

```bash
ADAPTER=/absolute/path/to/dsh-plugin/nanobrowser/mcp/adapter.mjs

# 1. 适配器能起来：超时设 0，它会立刻起自己的 Hub 并打印到 stderr
NANOBROWSER_HUB_WAIT_MS=0 NANOBROWSER_BRIDGE_PORT=8899 node "$ADAPTER" < <(sleep 1) 2>&1 | head -2
#   → [nanobrowser-mcp] [nanobrowser-hub] listening on http://127.0.0.1:8899
#   → [nanobrowser-mcp] started an embedded hub because no response came from ...

# 2. Hub 活着、扩展连着（换成你自己的端口和令牌）
curl -s 'http://127.0.0.1:8790/health?token=dev-token' | head -c 200
#   → {"ok":true,"connected":true,...}

# 3. 在客户端里让它调一次 status，再 attach + snapshot
```

`connected: true` + `status` 里列出扩展就说明整条链通了。

**端到端冒烟（只有仓库里能跑）**：

```bash
pnpm fixtures &                  # 起测试页面
node fixtures/hub-smoke.mjs      # 占一页、快照、读 console/network、还页，每步 ✓/✗
```

换机器包里没有这个脚本；在那台机器上照第 3 步做。
