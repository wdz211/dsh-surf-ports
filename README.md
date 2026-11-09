# dsh-surf-ports

> Four small capabilities for DeepSeek Harness in one bundle: chat-slang lexicon, token/cost ledger, context-ranked sticker picking, file snapshot/restore.

## 这是什么

这是给 **DeepSeek Harness Desktop** 用的一个插件包：把四个互不相干、但都很小、都很常用的能力
装进一个 bundle 里。四个能力各自解决一个具体的麻烦：

1. **群里的话看不懂** —— 每个群都有自己的一套黑话。`slang_lexicon` 负责把黑话抽出来、
   人工确认后存进库，再在需要的时候给出一段能直接塞进上下文的对照表。
2. **不知道钱花在哪** —— `token_usage` 是一门账：按会话 × 模型记 token 采样，
   用内置的价目表（含峰谷时段）折成人民币，出一张能看的报表。
3. **发哪张表情全靠猜** —— `sticker_best` 按当前聊天语境给表情打分：
   情绪相近 0.46 + 画面内容相近 0.38 + 关键词命中 0.16，并自动避开最近发过的。
4. **改错了文件想哭** —— `file_snapshot` 给「人格卡 / AGENTS.md / 预设」这类改错了会很难受的
   文件存快照，回档前还会自动再存一份当前状态，回错了还能回来。

另有一个顺手加进来的环境探查工具 `dsh_env`：DSH 桌面版每次启动都换一个回环端口，
写死的链接必然失效，所以需要「当前那只 DSH 监听的到底是哪个端口」这件事能问出来。

在 DSH 里的定位：**纯能力层，不接管任何流程**。它不监听消息、不主动说话、不做调度，
只提供五个工具，由会话/定时任务/其他插件在需要时调用。

其中 `src/` 下的 8 个判断模块是从上游 [surfcore](https://github.com/Mieksido/surfcore)
（MIT）**原样搬运**的，逐字节未改；工具外壳与一切适配都在 `index.js`。
来源与许可见 [ATTRIBUTION.md](./ATTRIBUTION.md)。

## 前置条件

**诚实地写**：这是 DSH 插件的源码，**不是独立 npm 库**。

- 需要一个跑起来的 DeepSeek Harness Desktop 宿主：插件靠宿主注入的 `ctx` 拿 `ctx.get('tools')`
  服务来注册工具，没有宿主就什么都注册不上（`apply()` 会打一条 warn 后返回，不抛异常）。
- Node.js 20+（仓库代码是 ESM，`"type": "module"`）。
- 有两处可选依赖，缺了不影响其它工具：
  - `sticker_best` 需要本机装了 `dsh-nekowhale-stickers` 并带 `meta/nekowhale.json` 元数据，
    否则它会明确返回「读不到 nekowhale 表情元数据」，不会假装挑到了。
  - `dsh_env` 的「枚举进程/端口」在 Windows 上走 `netstat` + `tasklist`；其它平台只做 HTTP 探活。

## 安装

插件目录要出现在宿主 profile 的 `node_modules` 里，并在 profile 的 bundle patch 层加一行挂载声明。

```powershell
# 1) 拷（或 junction 链接）到宿主 profile 的 node_modules
#    <dsh-home> 指你的 DSH 数据目录，例如 %USERPROFILE%\.dsh-beta
New-Item -ItemType Junction `
  -Path  "<dsh-home>\profiles\desktop\node_modules\dsh-surf-ports" `
  -Target "<仓库路径>\dsh-surf-ports"

# 2) 在 profile 的 bundle patch 里（YAML 顶层必须是数组）加一段 insert：
#    - insert:
#        - id: surf-ports
#          name: dsh-surf-ports
```

仓库里自带的 cordis.patch.yml 就是这个 bundle patch 层，内容只有一行 insert、不带 config
（数据根固定在数据目录下，没有需要配置的东西）。`name` 必须与安装后的包名一致，
否则 loader 只会 warn 并跳过这一行。

装完**完全退出 DSH 再启动**（bundle patch 与工具注册都是启动时一次性收集的，刷新页面不够）。

## 配置

**无配置项。** 所有状态都落在数据目录里，不由 patch 承载：

| 路径（相对 `<DSH_HOME>`） | 内容 |
| --- | --- |
| `surf-ports/slang.json` | 黑话库（confirmed + candidate） |
| `surf-ports/token-ledger.jsonl` | token 采样账本，一行一条 |
| `surf-ports/sticker-usage.json` | 表情使用账本（挑过/发过哪张、什么时候） |
| `surf-ports/snapshots/` | 文件快照本体 + `index.json` |
| `surf-ports/token-budget.json` | 每日额度（人民币 / token 双单位） |

`<DSH_HOME>` 的解析顺序：`$DSH_HOME` → `$DSH_HOME_BETA` → `~/.dsh-beta`（存在时）→ `~/.dsh`。

## 对外能力

五个工具，全部**同步返回 JSON**，并各自带一个 `render`（`render(args, value)` 两个参数，
返回 content blocks —— 这个签名写错只会在真跑时炸，`test/` 里有专门的用例钉它）。

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `slang_lexicon` | `action`(必): list / prompt / learn / promote / context / forget；`text`、`messages`、`entries`、`content`、`max` | 黑话库 CRUD。`prompt` 把群聊原文变成抽取提示词（插件自己不调模型）；`learn` 存确认过的条目（可 `status:"candidate"` 只登记候选）；`promote` 把候选升成 confirmed；`context` 回一段可直接进上下文的对照表（候选不参与注入） |
| `token_usage` | `action`(必): record / report / prices / clear；`session`、`turn`、`step`、`retry`、`model`、`at`、`usage{cacheMiss,cacheHit,cacheWrite,output,reasoning}` | 记一条采样（同 `session/turn/step/retry` **后到覆盖先到**，不累加——重连会重发同一批事件）；`report` 出报表（token + 人民币，按会话×模型拆）；`prices` 说某模型现在是峰时还是谷时、单价多少 |
| `sticker_best` | `context`(必)、`topK`、`minScore`、`used`、`avoidDays`、`allowRepeat`、`noMark` | 按语境挑 1~3 张。情绪相近 0.46 + 内容相近 0.38 + 关键词 0.16；默认排除最近 5 天发过的；挑中的默认记进使用账本（`noMark:true` 只挑不记，`used:[...]` 用于「真发了别的那张」） |
| `dsh_env` | `action`(必): discover / probe / ports / stamp；`url`、`file`、`compareTo` | `discover` 探测当前那只 DSH 的回环端口；`probe` 判断某地址是不是活着的 DSH；`ports` 列出回环监听端口；`stamp` 取文件版本戳（mtime+size），带 `compareTo` 时判断它有没有被别处改过 |
| `file_snapshot` | `action`(必): save / list / restore；`files`、`note`、`snapshot` | `save` 存一份（`files` 是绝对路径数组）；`list` 看有哪些；`restore` 退回某一份，**回档前自动再存一份当前状态**（`pre-restore-*`） |

## 为什么合成一个插件，而不是拆四个

三个理由，按分量排：

1. **多一个 bundle 就多一处启动失败的可能**。每个 bundle 都要在 profile 的 patch 层里占一行，
   多一行就多一个「name 写错 → loader 只 warn 并跳过」的静默失败点。四件小事配四个失败点不值。
2. **它们本来就不共享状态，拆开也没有隔离收益**。隔离的价值在于「一个坏了不连累另一个」；
   而这里的失败模式是「注册不上」，拆成四个只是把 1 个 warning 变成 4 个。
3. **它们的数据根是同一个**（`<DSH_HOME>/surf-ports/`）。四个目录各摊一个子目录，
   只是把同一块地方切碎，没有更清楚。

反过来说，如果哪天其中一件长到需要独立的定时任务、独立的面板、独立的服务依赖，
那就该拆出去——现在还没到那条线（`index.js` 814 行，其中一半是参数 schema 与 render）。

## 已知限制

1. **token 账本不会自己抓数**。DSH 的权威用量在 `session/follow` 的 `tokenUsage` 投影里，
   会话日志是 zstd 多 frame 压缩的，插件侧拿全量历史代价大、投影语义也会漂。这一版只收
   「已经数出来的数」，由调用方 `action=record` 喂进来。要做自动化得另做一个 ingest。
2. **`action=budget` 尚未出现在工具的 schema 里**。代码里额度闸已经实现（读当日账本 →
   按人民币/token 两套单位算比例 → 分 ok/near/over），但注册的 `action` 枚举只有
   `record / report / prices / clear`，所以现在只能从代码里调，模型调不到。
3. **黑话抽取依赖一次模型回合**。上游靠常驻 learner 会话，这里没有，所以拆成
   `prompt`（拿提示词）/ `learn`（存结果）两步，由调用方接。
4. **表情库是只读快照**。插件第一次用到时读 nekowhale 的元数据并缓存（约 322 条）；
   表情包升级后要重启 DSH 才会刷新。
5. **表情库缺失时是明确失败**，不是空结果：`sticker_best` 会返回
   「读不到 nekowhale 表情元数据（路径变了？）」——它不会假装「没挑到合适的」。
6. **`file_snapshot` 不自动巡检**。它不做定时备份，只在人明确要求时动；回档是覆盖写，
   唯一的保险就是回档前自动存的那一份 `pre-restore-*`。
7. **`dsh_env` 的进程枚举只有 Windows 有**。其它平台退化成纯 HTTP 探活，
   `ports` 会拿不到完整列表——它不会编一个列表出来。

## 开发

```bash
# 单测（不需要 DSH 宿主；用假 ctx 骗过 apply()，把注册的工具抓出来逐个执行）
node --test test/*.test.mjs
```

结构：

```
index.js              工具外壳：参数 schema、render、数据根、落盘策略
src/                  上游原样搬运的 8 个判断模块（见 ATTRIBUTION.md）
test/                 14 条用例，含「render 两参」「未知 action 必须报错」这类只有真跑才炸的坑
cordis.patch.yml             bundle 挂载声明（一行 insert，无 config）
```

测试里依赖真实表情库的三条用例会自己 skip（干净机器 / CI 上没有 `dsh-nekowhale-stickers`），
不会变成红灯；其余 11 条在临时目录里跑，绝不碰真实数据目录。

## 许可

MIT，见 [LICENSE](./LICENSE)。

**上游代码**：`src/` 下 8 个文件原样搬运自 [surfcore](https://github.com/Mieksido/surfcore)
（MIT，`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`），逐字节未改。

**我们写的**：`index.js`（工具定义、schema、render、nekowhale 元数据映射、数据根与落盘策略）、
`test/`、全部文档与 CI 配置。

逐文件的来源、行数与许可原文见 [ATTRIBUTION.md](./ATTRIBUTION.md)。
