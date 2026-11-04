# Nanobrowser 参考手册

> 精确清单：工具、配置、recipe 格式、路径、命令、错误码。设计意图见 [design.md](./design.md)。
> 本文中出现的名字都可以被脚本对照代码校验；改代码时同步改这里。待办见 [roadmap.md](./roadmap.md)。

## 1. 运行面

| 项 | 值 |
|---|---|
| Hub 监听 | `http://127.0.0.1:8790`（只本机） |
| Hub token | 默认 `dev-token`，由 `NANOBROWSER_BRIDGE_TOKEN` 或配置覆盖 |
| Hub 端口 | 默认 `8790`，由 `NANOBROWSER_BRIDGE_PORT` 覆盖 |
| 适配器的技能目录 | 默认同插件（`~/.dsh/skills/browser`），由 `NANOBROWSER_SKILLS_DIR` 覆盖（测试用） |
| 扩展 ↔ Hub | 扩展主动轮询：`GET /poll`、`POST /result`（每条结果带 `tab: {tabId, url, title}`）、`POST /event`（`tab` / `tab-closed`，让租约跟着页面走）、`GET /health` |
| 侧边栏 ↔ worker | `chrome.runtime.sendMessage`：`prompts:list`、`prompt:answer`（写审批卡，见 §3） |
| 左侧栏 ↔ Host | `GET /nanobrowser/summary`（页面每 3 秒轮询：hub 状态、会话、技能与参数、最近调用）、`GET /nanobrowser/skill?name=`（一个技能的 `SKILL.md`、`recipe`、学到的记录）、`POST /nanobrowser/skill/run`（在有租约的会话上跑；`dryRun: true` 只预检）、`GET /nanobrowser/audit?session=&tab=&limit=&format=csv`（按会话/标签页筛的审计，`format=csv` 直接给下载）；四条都要 DSH 自身的同源校验 |
| 客户端 ↔ Hub | `POST /client/register`、`/client/call`、`/client/cancel`、`/client/lease`、`GET /client/events`、`DELETE /client/lease`、控制路由 `GET /client/tabs`、`POST /client/tab`、`POST /client/tab/release`（只还一个页面，任务保留）、任务入口 `POST /client/task`（需要插件，没有就 503）、只读 `GET /client/audit` |
| 侧边栏 ↔ Hub | `ws://…/client/chat/ws`（`hello`/`sessions`/`select`/`send`/`stop`/`approval`/`user-step`）；**租约每变一次，Hub 主动重发 `sessions`**，其中每个会话带 `tabs`，面板据此更新 chips 与标签组 |
| 租约形状 | 一个客户端 → 一组标签页（`{clientId, sessionId, kind, tabId, tabs, since}`，`tabId` 是最近拿到的那个）；每个标签页同一时刻只有一个 owner |
| 空轮询超时 | 20s |
| 调用超时 | 360s（`callTimeoutMs`） |
| 连接判活 | 60s 无轮询视为断开；`/health` 与 `status()` 带 `connectedAt`（这次连上）与 `disconnectedAt`（这次断开），页面据此显示"2 秒前" |
| Hub 的请求来源 | `Origin` 是 `http(s)…` 的请求一律 403（CORS 预检也拒，WebSocket 升级也拒）；扩展页（`chrome-extension://`）与本机程序（无 Origin）照常。token 是第二道，默认 `dev-token` 是公开的 |
| 审计上限 | 200 条事件（约 100 次调用）；`GET /client/audit` 与左侧栏的 `limit` 最多 100，每条带 `tabId`（扩展随结果回报的标签页） |
| Fixture 服务 | `http://127.0.0.1:8787`（`pnpm fixtures`） |
| 构建标志 | `WXT_BRIDGE`（有值才启用外部桥接） |

### 1.1 侧边栏里的任务页面（chips 与标签组）

- 会话列表来自 Hub，每个会话带 `tabs`（它租到的页面）。面板把选中任务的这些页面显示成 chips：点名字切过去，点 × 调 `POST /client/tab/release` 只把这一个页面还回去，任务保留其余页面。
- 每个任务在 Chrome 里是一组标签页，组名就是会话标题（第一条用户消息之后才有内容，所以会更新一次）；图标颜色交给 Chrome 默认。
- 任务自己打开的页面（`window.open`、`target=_blank`）随租约进入 `tabs`，于是自动进组；离开任务的页面在一次对齐时移出组。
- **不是面板创建的组只认领、不改名**：用户手动改过的组名保留。一个组只能在一个窗口，只给任务第一个页面所在窗口分组。
- 分组由侧边栏做，所以面板关着时不做分组，打开时按当时的租约一次对齐。分组失败（没权限、页面已关、跨窗口）一律静默：它只是视图，不影响归属。

## 2. 浏览器工具（18 个，模型看到的名字是 `nanobrowser_<name>`）

| 工具 | 作用 | 读/写 | 需要租约 |
|---|---|---|---|
| `navigate` | 打开 URL、后退/前进/刷新 | 写（页面变化） | 是 |
| `snapshot` | 元素大纲：角色、名字、状态、值 | 读 | 否 |
| `read` | 整页或某元素转 Markdown / 文本 | 读 | 否 |
| `find` | 在最近一次观察里按角色/名字/文本找元素 | 读 | 否 |
| `screenshot` | 可见区域 / 整页 / 单个元素 PNG | 读 | 否 |
| `click` | 可操作性检查后投递可信点击 | 写 | 是 |
| `set` | 给控件赋值：文本、勾选、单选、开关、下拉 | 写 | 是 |
| `type` | 逐键输入 | 写 | 是 |
| `press` | 按键或组合键 | 写 | 是 |
| `hover` | 指针移入 | 移动（不审批） | 是 |
| `scroll` | 翻页/像素/到顶到底/滚到元素 | 移动（不审批） | 是 |
| `wait` | 等文本出现/消失、元素状态、URL、固定毫秒 | 读 | 是 |
| `tabs` | 列出/打开/切换/关闭**本会话的**标签页 | `list` 读，其余写 | `list`/`open` 否，其余是 |
| `handle_dialog` | 接受/拒绝对话框 | 写 | 是 |
| `console` | 读取标签页自 attach 以来的控制台消息 | 读 | 否 |
| `network` | 读取网络请求与失败 | 读 | 否 |
| `say` | 在侧边栏显示一句话 | 无副作用 | 否 |
| `reload-extension` | 重载已加载的扩展 | 无页面副作用 | 否 |

租约规则只有一处实现：`core/tools.js` 的 `needsLease()`，Hub、插件 guard、`runSkill` 都问它。需要租约 = 9 个动作工具（`navigate`、`click`、`set`、`type`、`press`、`hover`、`scroll`、`wait`、`handle_dialog`）+ `tabs` 的 `select`/`close`。

免租约：观察类（`snapshot`、`read`、`find`、`screenshot`、`console`、`network`）与 `say`、`reload-extension`、`tabs` 的 `list`/`open`，以及插件工具 `status`、`attach`、`detach`、`audit`。理由：面板发消息时要读它所在的页面；只读诊断不该先抢页面；看到一个不归自己的标签页也没用，因为操作会被拒。`wait` 只读，但只出现在流程里，归动作类。

## 3. 插件工具（模型可见）

| 工具 | 作用 | 需要租约 |
|---|---|---|
| `nanobrowser_status` | Hub 连接、客户端、租约、待处理调用 | 否 |
| `nanobrowser_attach` | 占用一个标签页（可指定 tabId 或新开 URL）；**唯一**把会话外标签页纳进来的入口，不带参数时顺便列出其它页 | 否 |
| `nanobrowser_detach` | 释放标签页 | 否 |
| `nanobrowser_audit` | 最近的浏览器调用记录 | 否 |
| `nanobrowser_wait_for_user` | 暂停，等用户在页面完成登录/2FA/验证码 | 否 |
| `browser_skill_save` | 从一轮对话录制技能 | 需要活会话 |
| `browser_skill_list` | 列出技能 | 否 |
| `browser_skill_show` | 显示 SKILL.md 与 recipe | 否 |
| `browser_skill_run` | 回放技能；`from` 从某步续跑，`until` 停在某步，`batch` 逐项跑并汇总 | 是 |

### 3.1 写审批卡的四种回答

站点规则为 ask（或模式是 Ask 且没有规则）时，写操作会停下来问。卡片上的选择：

| 回答 | 作用 | 作用域 |
|---|---|---|
| 允许一次 | 这次写操作照做 | 本步 |
| 在 {site} 上始终允许 | 写一条站点规则（`allow`） | 该站点，持久（设置页里可以改回来） |
| 允许本任务 | 在这个标签页上不再问写操作 | 内存里的授权，30 分钟上限，`detach`/worker 重启/`withdrawAll` 结束；**不写站点规则** |
| 拒绝 | 不派发，报 `USER_DECLINED` | 本步 |

"允许本任务"是批次那一层：`browser_skill_run` 的 `batch` 逐项跑时，第一单问一次，其余走这条授权。没有面板在听就没人答，layer 的时钟走完按拒绝处理。

## 4. 配置项（`dsh-plugin/nanobrowser/core/config.js`）

| 键 | 默认值 | 范围/说明 |
|---|---|---|
| `port` | `8790` | Hub 端口 |
| `token` | `dev-token` | Hub 令牌 |
| `callTimeoutMs` | `360000` | 单次调用超时 |
| `skillsDir` | `~/.dsh/skills/browser` | 用户技能目录（可写） |
| `builtinSkillsDir` | `<repo>/skills/browser` | 内置技能目录（只读）；默认由插件填入 |
| `taskCwd` | `~`（`os.homedir()`） | 从浏览器发起的任务的 cwd；不继承 DSH 进程碰巧的目录 |
| `stepDelayMs` | `350` | 回放步间停顿，`0–2000` |
| `maxSteps` | `40` | 录制与回放的步数上限，`1–100` |
| `pageContextChars` | `4000` | 页面摘要预算，`500–12000` |
| `approvalTimeoutMs` | `120000` | 抽屉审批超时，`5000–600000` |
| `userStepTimeoutMs` | `120000` | 用户步骤超时，`5000–600000` |

## 5. 技能目录与文件

| 路径 | 内容 |
|---|---|
| `~/.dsh/skills/browser/<name>/SKILL.md` | 人写的说明（被目录发现） |
| `~/.dsh/skills/browser/<name>/recipe.json` | 机器执行的步骤 |
| `~/.dsh/skills/browser/.knowledge/<name>.json` | 这个技能自己学到的失败记录（§4.2，不是技能目录） |
| `<repo>/skills/browser/<name>/` | 随仓库发布的内置技能（只读） |

查找顺序：用户目录优先，同名覆盖内置。

### `recipe.json` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 小写字母、数字、连字符，1–64 字符 |
| `version` | number | 否 | 覆盖保存时自增 |
| `description` | string | 是 | 出现在技能目录 |
| `whenToUse` | string | 否 | 模型判断何时使用的提示 |
| `origin` | string | 否 | 站点锁，如 `https://shop.example.com` |
| `params` | object | 否 | 参数名 → `{type: string\|number\|boolean, required, default}`；也接受裸值（类型取自值本身，必填、无默认） |
| `steps` | array | 是 | 1..`maxSteps` 个步骤 |
| `onFail` | object | 否 | 失败码 → 动作，`*` 兜底；recipe 级与 step 级都可用，动作是 `stop`/`report`/`ask`/`skip`（`skip` 只在 `delivered:false` 时生效） |
| `assert` | array | 否 | `{after: "<步 id>", …}`，五选一：`text`（在页上）、`text`+`absent: true`（不在页上）、`url`（包含）、`consoleErrors`（上限）、`network: {url, status}` |
| `createdFrom` | object | 否 | 录制来源：sessionId / turn / at |
| `needsReview` | boolean | 否 | 有目标只能记成 ref，需要人工看 |
| `modelInvocable` | boolean | 否 | 默认 true；false 时模型不能在目录里选它 |

### 步骤

```json
{ "id": "s1", "tool": "click", "target": { "role": "button", "name": "下一步" }, "args": {} }
```

- `tool` 只能是 9 个动作：`navigate`、`click`、`set`、`type`、`press`、`hover`、`scroll`、`wait`、`handle_dialog`。
- `target` 支持 `role`、`name`、`ref`、`nth`、`within`；`click`/`set`/`hover` 必须有目标。**录制出的 recipe 只有 `role`/`name`/`nth`**：`ref` 和 `within` 属于产出它的那个文档，录不进 recipe。
- 参数占位符：`{{name}}`；值可以是整个字符串或字符串中的一段。
- `wait` 支持 `ms`、`text`、`textGone`、`url`、`state`（默认 `visible`）、`target`。**优先用条件（`text`/`url`/`target`+`state`），少用 `ms`**：固定等待是赌网络，慢下来就断；录制器遇到"等待后面跟着有目标的动作"会自动记成 `target` + `state: visible`，改不了的会在汇总里提示。
- 断言在步骤成功后检查；`text` 用 `wait` 轮询 2s，`url` 用当前标签页 URL 包含关系。

### 5.1 `SKILL.md` 的限制与约定

- frontmatter 只解析**扁平键**（`parseFrontmatter` 逐行 `key: value`）：嵌套 YAML 会静默失效，需要结构就写进 `recipe.json`。
- 标题固定认 `## When it fails`：失败时 runner 只从这一段里找"反引号里写了失败码或步 id"的 bullet，最多 3 条。
- 录制器写出的 `SKILL.md` 第一行是 `<!-- generated by browser_skill_save -->`；**手写的文件没有这一行，保存同名 recipe 时不会被覆盖**（只更新 `recipe.json`）。

### 5.2 失败策略与 SOP 召回（I1 / I3）

- `onFail` 顶层写默认，step 里覆盖；查找顺序 `step[code]` → `step["*"]` → `recipe[code]` → `recipe["*"]` → `stop`。码就是结果里的 `error.code`（layer 的 35 个 + runner 的 `ASSERT_*` 等，见 §7）。
- `report` 让运行以 `ok:true` + `data.outcome:"reported"` 结束（"已经提交过"不该算失败）；`ask` 是 `ok:false` + `"asked"`；`skip` 在 `delivered:false` 时把这一步记成 ✗ 后继续，否则降级成 `stop`。
- 运行结果里 `data.outcome` 只有四种：`done`、`stopped`（`until`）、`reported`、`failed` / `asked`。
- `SKILL.md` 里的 `## When it fails` 段：匹配规则见 §5.1；命中时附在失败文本与 `data.knowledge` 里，没有这一段就什么都不加。

### 5.3 失败入库：技能自己学到的记录

手写段说"作者知道的坑"，这一节说"机器遇到过的坑"。

- 每次**真跑**失败（`outcome: "failed"` 且有步 id），runner 往该技能的记录里写一条：`code`、`stepId`、`step`（那一步在做什么）、`message`、`hint`、`url`、`count`、`firstSeen`、`lastSeen`。同一 `(code, stepId)` 只加 `count`。
- 下一次失败时先读记录再匹配（码或步 id 相同即命中），按次数排序，最多 3 条，附在 `Learned from earlier failures of this skill:` 之后并进 `data.learned`。手写段命中时学到的只留 2 条。
- **不记**：dry run、取消，以及 `NO_LEASE`、`INVALID_RECIPE`、`INVALID_PARAMS`、`MISSING_PARAMS`、`SECRET_PARAM`、`ORIGIN_MISMATCH`——它们说的是调用，不是页面。
- 写入尽力而为：目录不可写时本次运行照常返回失败。读取在写入之前，所以这次失败不会把自己算成"以前见过"。
- 一个文件最多 12 条（按 `lastSeen` 留最新）、字段截到 240 字符。`browser_skill_show` 列出全部记录，`browser_skill_list` 在那一行显示 `learned <n>`。

## 6. 命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖（含 `wxt prepare`） |
| `pnpm dev` | 开发模式，把 `dist/` 加载为未打包扩展 |
| `pnpm build` | 构建 MV3 扩展到 `dist/` |
| `pnpm zip` | 构建并打包到 `dist-zip/` |
| `pnpm type-check` | TypeScript 检查 |
| `pnpm lint` | ESLint（含导入规则） |
| `pnpm test` | Vitest 单元测试 |
| `pnpm prettier` | 格式化 |
| `pnpm fixtures` | 本地 fixture 服务（8787） |
| `pnpm install-chrome` | 安装 Chrome for Testing（必须带 `--use-mock-keychain`） |
| `pnpm clean-chrome` | 清理 `~/.cache/puppeteer` |
| `pnpm autorun <checks>` | 无头 Chrome 跑扩展内自动检查，结果写 `fixtures/.results/` |

## 7. 错误码（layer 协议，共 35 个）

| 分组 | 错误码 | 含义/下一步 |
|---|---|---|
| ref 与文档 | `REF_UNKNOWN`、`REF_NOT_PRESENTED`、`REF_TAB_MISMATCH`、`STALE_DOCUMENT`、`NODE_DETACHED`、`TARGET_CHANGED` | 重新快照，再选一次 |
| 定位 | `AMBIGUOUS_TARGET`、`NO_MATCH` | 加 `nth`/`within`，或先看页面 |
| 可操作性 | `NOT_VISIBLE`、`NOT_STABLE`、`DISABLED`、`NOT_EDITABLE`、`OBSCURED`、`INTERCEPTED`、`NOT_INTERACTABLE` | 先处理遮挡/禁用；`INTERCEPTED` 不可盲目重试 |
| 表单 | `NO_SUCH_OPTION`、`AMBIGUOUS_OPTION`、`STATE_UNCHANGED` | 选项不匹配或值未生效 |
| 阻塞 | `MODAL_PENDING`、`USER_DECLINED`、`USER_STEP`、`CONFIRMATION_TIMEOUT`、`NEEDS_USER` | 先解决弹窗；用户动作不代做 |
| 框架/连接 | `FRAME_DETACHED`、`DEBUGGER_DETACHED`、`TAB_NOT_IN_SESSION` | 重新快照或重新 attach |
| 页面/导航 | `URL_NOT_ALLOWED`、`NAVIGATION_FAILED`、`PAGE_NOT_SUPPORTED`、`CAPABILITY_DISABLED` | 地址或能力问题，只能由用户开 |
| 采集与参数 | `CAPTURE_FAILED`、`INVALID_ARGUMENT`、`TIMEOUT`、`CANCELLED`、`INTERNAL` | 重试采集或修参数 |

每个码都带一句 hint；`INTERCEPTED` 另有"已部分投递"的版本。layer 的结果是 `{ok, text, error: {code, message, delivered, hint, details?}}`，其中 `text` 已经把三句渲染好（`error CODE (投递状态)` / message / hint）。

### 7.1 插件自己的码（不在上面 35 个里）

Skill runner 与 Hub 在 layer 之外产生失败，用同样的形状（`{code, message, hint, delivered}`）报，好让模型和以后的 SOP 召回只认一个字段：

| 码 | 产生方 | 含义 |
|---|---|---|
| `INVALID_RECIPE` | runner | recipe 不合格（没步骤、超步数、工具未知、目标缺失） |
| `MISSING_PARAMS` | runner | 必填参数没给 |
| `INVALID_PARAMS` | runner | 参数类型对不上（`amount` 要数字却给了 `tbd`）；能无歧义读出来的会转换并在汇总里说明 |
| `SECRET_PARAM` | runner | recipe 里有 `{{secret:…}}`，值不进模型、不入技能文件 |
| `NO_LEASE` | runner / Hub | 会话没有绑定标签页；Hub 的拒绝也带这个码 |
| `ORIGIN_MISMATCH` | runner | `recipe.origin` 与当前标签页不同源，且第一步不是导航过去 |
| `TARGET_NOT_FOUND` | runner | dry run 解析不到目标 |
| `ASSERT_TEXT` / `ASSERT_TEXT_PRESENT` / `ASSERT_URL` / `ASSERT_CONSOLE` / `ASSERT_NETWORK` | runner | 断言没过（文本在、文本还在、URL、console 错误数、network 状态） |
| `STEP_FAILED` | runner | 某步失败但 layer 没给码（少见，例如 Hub 掉线） |
| `CANCELLED`、`INTERNAL` | 两者同名 | 取消 / 未分类的内部失败 |

## 8. 已知不一致

（空）现在没有。

这一节只在**代码与文档确实不一致**时开一行，修好就删掉；它不是待办清单（待办在 [roadmap.md](./roadmap.md)）。`pnpm docs:check` 能查出工具名、配置键、脚本名、路径和相对链接的错，查不出"这句话还是不是真的"——数字和结论要人看一眼。
