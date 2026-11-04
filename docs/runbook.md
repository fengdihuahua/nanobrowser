# 装、跑、出问题怎么办

> 这是**唯一**的安装与运行页。README 的 Install 段、已退役的 `install-for-others.md`、`dsh-plugin-new-machine-runbook.md`、`dsh-plugin-migration.md` 的内容都收敛到这里。
> 相关：[design.md](./design.md)（怎么设计的）、[reference.md](./reference.md)（工具/配置/错误码的现状）、[roadmap.md](./roadmap.md)（还差什么）。
> 最后更新：2026-11-04。

## 0. 三样东西要凑齐

| 东西 | 是什么 | 谁提供 |
|---|---|---|
| 扩展 | 手和眼睛：驱动标签页、弹审批卡、侧边栏 | 你自己构建或下载 zip，加载进 Chrome |
| Hub | 队列、租约、审计；只监听 `127.0.0.1:8790` | DSH 插件内嵌一个，或 MCP 适配器自起一个 |
| 客户端 | 大脑：模型、循环、会话 | DSH（插件路径），或任意 MCP 客户端 |

**扩展里没有大脑**：没有模型、没有 key、没有会话存储。大脑有两个可能的位置——DSH 插件，或者你的 MCP 客户端。只接 MCP 时**不需要 DSH**：适配器自己起一个 Hub（见 §3）。

前置：

- Chrome 或 Edge 125+，用**你自己的 profile**（登录态正是重点）。
- DSH，用插件路径时必需。
- Node 24.22.1+，**只有自己构建扩展时**需要；装 zip 的话只要有浏览器。
- Git，可选（从源码构建时需要）。

## 1. 装扩展

### A. 用 release zip（不构建）

两个包，名字不同、用途不同：

| 包 | 用途 |
|---|---|
| `nanobrowser-<version>-bridge.zip` | **要让 Hub 驱动它就用这个**（DSH 插件、MCP 客户端）。worker 会轮询 `127.0.0.1:8790` |
| `nanobrowser-<version>.zip` | 普通构建，不连 Hub：只适合当普通的扩展用 |

自己打这两个包：

```bash
pnpm zip                      # 普通
WXT_BRIDGE=1 pnpm zip         # 带桥接；产物同名，按需重命名
```

1. 解压到固定的位置。
2. `chrome://extensions` → 打开开发者模式 → **加载已解压的扩展程序** → 选解开的目录。
3. 打开任意普通页面，点扩展图标（或按 `Alt+Shift+N`）：侧边栏出现。

### B. 从源码构建

```bash
git clone <你的仓库地址>
cd nanobrowser
pnpm install
WXT_BRIDGE=1 pnpm build      # 没有这个标志，worker 不会去轮询 Hub
```

然后同上，`加载已解压` 指向 `dist/`。

构建标志：

```
WXT_BRIDGE=1
WXT_BRIDGE_PORT=8790         # 与 Hub 一致
WXT_BRIDGE_TOKEN=dev-token   # 与 Hub 一致
```

## 2. 装 DSH 插件（两条 bundle）

```text
plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser enabled:true
plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser-ui enabled:true
```

装完重启一次 DSH。`nanobrowser` 是 Host（Hub、工具、技能）；`nanobrowser-ui` 是左侧栏那一页，只装 Host 的话左侧栏不会出现。

如果 profile 里还留着旧产品的 MCP 行：

```text
plugin_manager set_plugin include:mcp-nanobrowser enabled:false
```

没有这一行就跳过。

## 3. 只接 MCP 客户端（不要 DSH）

```jsonc
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": ["<repo>/dsh-plugin/nanobrowser/mcp/adapter.mjs"],
      "env": { "NANOBROWSER_BRIDGE_PORT": "8790", "NANOBROWSER_BRIDGE_TOKEN": "dev-token" }
    }
  }
}
```

这条路径上**不需要 DSH**：适配器启动时先问 `GET /health`，三秒没人答就自己起一个 Hub（同端口同令牌）。两个 MCP 客户端可以各占一个标签页（`attach` 时各自挑空闲页）。能力面与差异见 [mcp.md](./mcp.md)，接入步骤见 [mcp-clients.md](./mcp-clients.md)。

**先起谁**：只接 MCP 时什么都别先起，适配器自己就是 Hub；DSH 也在跑时让它先起，适配器会连上它那个，不会再起第二个（端口会撞）。

## 4. 装完先验这七条

1. 问一次 `nanobrowser_status` → 必须是 `connected`。
2. 左侧栏出现 `nanobrowser` 条目（UI bundle 装对了）。
3. `browser_skill_list` → 至少 `add-two-rows`、`fill-signup`。
4. `nanobrowser_attach`（不带参数）→ 占一个空闲标签页；`nanobrowser_snapshot` 返回带 ref 的大纲。
5. 打开一个普通页面 → 侧边栏 **DSH** → 抽屉里是本会话的历史；在输入框旁按 `+` 能在当前页发起一个新任务。这个页面会进到以任务命名的标签组里，抽屉上方出现它的 chip（点 × 可把这一页移出任务）。
6. 左侧栏的技能卡：点【运行】填参数、【只预检】勾上再点【开始】→ 只解析目标、页面不动；点【文件】→ 看到 `SKILL.md`、`recipe.json`、以及这个技能自己学到的失败记录。
7. 左侧栏的审计卡：按会话或标签页筛一次，点【导出 CSV】→ 下一份带 `tabId` 的表格，行数不超过条数上限。

一条命令的冒烟（需要 Hub 和扩展都在）：

```bash
node fixtures/hub-smoke.mjs
```

它注册一个客户端、打开 fixture 页、快照、读 console/network，然后把标签页还回去。每步打印 ✓/✗，失败时退出码 1。`--port`/`--token` 对应非默认 Hub，`--url` 换页面。

## 5. 技能放哪

- 用户自己的：`~/.dsh/skills/browser/<name>/{SKILL.md, recipe.json}`，换项目也一样。失败学到的东西在同目录的 `.knowledge/<name>.json`（不是技能，删掉只丢经验）。
- 随仓库发布的：`<repo>/skills/browser`，插件从自己身边读（`builtinSkillsDir`）。
- 两边同名时，用户目录的优先。
- 给别人的技能就是一个目录：把 `SKILL.md` 和 `recipe.json` 拷进对方的 `~/.dsh/skills/browser/`，或提交到 `skills/browser/` 跟着下次构建走。recipe 带 `origin` 锁，在一个站点录的技能不会在另一个站点上跑。

## 6. 出问题先看这张表

| 现象 | 先查什么 |
|---|---|
| `nanobrowser_status` 说 disconnected | 扩展是不是用 `WXT_BRIDGE=1` 构建的；构建后 worker 有没有重载；有没有开着一个普通页面 |
| 工具栏按钮没反应 | 构建早于面板修复；重新构建并重载。`Alt+Shift+N` 走同一个 handler |
| 8790 端口被占 | 旧的 MCP bridge 或老插件占着。`port` 和 `token` 两端一起改 |
| 冒烟报 `ERR_CONNECTION_REFUSED` | 它要打开的那页没人服务。先 `pnpm fixtures`，或传 `--url` |
| 左侧栏没有 nanobrowser | `nanobrowser-ui` 没装或没启用 |
| 技能缺失 | `~/.dsh/skills/browser` 不可写，或 checkout 的 `skills/browser` 不在插件旁边——用 `builtinSkillsDir` 指过去 |
| `wait_for_user` 说抽屉没开 | 抽屉得是**展开**状态，不是只亮着 DSH 按钮：WebSocket 只在展开时连着 |
| `attach` 说所有页都被占 | 别的客户端（DSH 会话或另一个 MCP 客户端）正占着；`detach` 或换一页 |
| 卡片等了很久没反应 | 审批卡 240s、调用 360s 超时；两边的语义见 [reference.md](./reference.md) §1 |
| 接口回 403 `a web page may not drive this hub` | 请求是从网页发出的（带了网页 `Origin`）。用扩展、DSH 或命令行；网页控制台里调不了 |

## 7. 这台 Mac 上的注记

这些是**在 DSH 的沙箱里构建**才会遇到的；普通终端里 `WXT_BRIDGE=1 pnpm build` 没这些问题。

- **SWC 原生模块**：`@swc/core` 1.16 加载时要把 addon 复制到 `~/Library/Caches/swc-native-501`，沙箱不许写外部目录就会报 `Failed to load native binding`（误导人的名字，其实是 EPERM）。给一个可写的缓存目录即可：

  ```bash
  SWC_NATIVE_BINDING_CACHE=/private/tmp/nb-swc npx wxt build
  ```

  注意 `/tmp` 在 macOS 上是指向 `/private/tmp` 的符号链接，SWC 拒绝符号链接的缓存根目录，所以必须写 `/private/tmp/...`。构建完删掉。

- **`pnpm` 本身**：沙箱里 `pnpm` 会因 `~/Library/pnpm/.tools/...` 不可写而 EPERM，用 `npx` / `node` 直跑脚本。
- **Node 版本**：仓库要求 `>=24.22.1`；低于它时 `pnpm` 会因 `engine-strict` 拒绝，设 `npm_config_engine_strict=false` 或换 Node。
- **Mock keychain**：Chrome for Testing 永远不能碰真实 Keychain，任何启动都要带 `--use-mock-keychain`（`pnpm autorun` 已经带）。

## 8. 搬到另一台机器

**拷一个文件就够**：`dist-zip/nanobrowser-<version>-for-another-machine.zip`。里面有

```
nanobrowser-<version>/
  INSTALL.md            对方看完就能装
  extension/*.zip       两个扩展包（用 -bridge 那个）
  dsh-plugin/           插件 + Hub + MCP 适配器
  skills/browser/       内置技能
```

解压到固定路径后按包里的 `INSTALL.md` 走：装扩展 → 配 MCP 客户端（或装 DSH bundle）。**不需要仓库、不需要 `npm install`、不需要 git**，只要 Node 24+（跑适配器）和 Chrome/Edge 125+。

自己打这个包（改完代码要重打）：

```bash
WXT_BRIDGE=1 npx wxt zip && mv dist-zip/nanobrowser-*.zip dist-zip/nanobrowser-<version>-bridge.zip
npx wxt zip                       # 普通构建
# 然后把 dsh-plugin/、skills/、extension/ 和一份 INSTALL.md 放进同一个目录再 zip
```

另外两样也一起带走：

- `~/.dsh/skills/browser/`——你自己录/手写的技能（不在包里）；
- `~/.dsh/sessions`（可选）——会话本身不迁移；工作区路径不一致时会话会显得错位。
