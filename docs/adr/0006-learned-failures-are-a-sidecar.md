# ADR 0006：失败记录是旁挂文件，不改 `SKILL.md`，也不进 `recipe.json`

- 状态：已采纳
- 日期：2026-11-04
- 相关：[design.md](../design.md) §9.2；[roadmap.md](../roadmap.md) C5；ADR 0001、0005

## 背景

C5 要的是"失败一次即有一条可复用记录"：技能自己遇到过什么坑，下一次失败时能说出来，而不是每次都靠人去写 `## When it fails`。

落点有四种：往 `SKILL.md` 追加、写进 `recipe.json`、单独的旁挂文件、让模型自己记一条。

约束是清楚的：

- `SKILL.md` 可能是**人写**的。录制器只覆盖带 `GENERATED_SOP` 标记的文件，这条规则不能破。
- 随仓库发布的技能目录（`skills/browser/`）是**只读**的，运行时不能往里写。
- 记录要能 diff、能被同事拷走，所以得是文件，不能是内存。
- 记录会随每次失败增长，必须定长，否则技能目录会慢慢变成日志目录。

## 决策

**一个技能一个旁挂 JSON，放在用户技能目录的 `.knowledge/<name>.json`。**

```json
{
  "skill": "submit-order",
  "notes": [
    {
      "code": "NO_MATCH",
      "stepId": "3",
      "step": "click button «提交»",
      "message": "No element matches.",
      "hint": "Take a snapshot to see what the page contains.",
      "url": "https://…/orders/1001/edit",
      "count": 2,
      "firstSeen": "2026-11-04T06:00:00.000Z",
      "lastSeen": "2026-11-04T06:02:00.000Z"
    }
  ]
}
```

- **一个 (code, stepId) 一条**，重复只加 `count`：同一个坑踩一百次也是一行，不是一百行。
- **每个文件最多 12 条**，字段截断到 240 字符，按 `lastSeen` 留最新的。记录说的是"现在会怎么坏"，不是"历史上坏过什么"。
- **先读后写**：这次失败不会被当成"以前见过"。
- **同一技能的写入串行**（进程内一条队列）：两次运行同时失败不会互相覆盖。
- **只记真跑**：dry run、取消，以及 `NO_LEASE`/`INVALID_RECIPE`/`INVALID_PARAMS`/`MISSING_PARAMS`/`SECRET_PARAM`/`ORIGIN_MISMATCH` 这类"说的是调用、不是页面"的失败都不记。
- **写在用户的 `skillsDir` 下**，所以内置技能（只读、在仓库里）也能学，而仓库一个字节都不会被改。

## 被否掉的

- **追加到 `SKILL.md`**：手写的是人的判断，机器追加后没人能分清哪句是谁说的；也会和"录制器只覆盖自己写的文件"那条规则打架。
- **塞进 `recipe.json`**：recipe 是**执行的步骤**（ADR 0001 分开的两样东西之一，ADR 0005 又把它钉成 JSON），学到的观察不是步骤；混进去会让校验和编辑都变脏。
- **一个全局文件记所有技能**：跨技能串味，分享一个技能时带不走它自己的经验。
- **让模型自己写一条**：模型只能说"下次注意"，那是猜测；runner 记的是事实（码、步、页面原话、URL、次数），免费且确定。
- **放仓库内置目录**：运行时改代码树，装成只读包时直接失效。

## 后果

- `docs/reference.md` §5 的文件表多一行；`.knowledge/` 目录名不匹配技能名规则，所以不会被 `listSkills` 当成技能。
- 失败文本多一段 `Learned from earlier failures of this skill:`，结果里多一个 `data.learned`；`browser_skill_show` 能看到一个技能的全部记录，`browser_skill_list` 显示条数。
- 记录会过时：页面改版后旧记录可能误导。它出现时是"上次这样坏过"的提示，不是断言；想清掉就删文件，没有别的开关。
