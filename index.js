/**
 * @local/dsh-surf-ports — 从 surfcore 定点迁移的四件小东西。
 *
 * 为什么合成一个插件而不是四个：
 *   四件都不大、互相独立，但**每挂一个 bundle 就多一处启动失败的可能**。四份
 *   cordis.patch.yml + 四次 import 解析，换不来任何隔离收益（它们本来就不共享状态）。
 *   所以一个插件、四个模块、四次 tools.register。
 *
 * 迁移原则（与 dsh-purpose 一致）：**上游纯逻辑一字不改，差异全在适配层**。
 *   src/model-prices.js      verbatim（零 import）
 *   src/sticker-semantics.js verbatim（零 import）
 *   src/slang-learner.js     verbatim（依赖 md-to-plain.js，一并搬）
 *   src/token-ledger.js      verbatim
 * 这四件的判断/评分/折算全是上游在真实流量上校准过的，重写只会把经验换成一堆想象。
 *
 * 四个工具：
 *   slang_lexicon    群聊黑话表：学 / 看 / 注入 / 忘
 *   token_usage      token 用量账本：记 / 报表 / 折成人民币
 *   sticker_best     按语境挑表情（情绪 0.46 + 内容 0.38 + 关键词 0.16）
 *   file_snapshot    文件快照/回档（人格卡、AGENTS.md 这类"改错了会很难受"的文件）
 *
 * fail-open：所有 execute 顶层 try/catch，异常一律变成 `{ ok:false, error }`，
 * 绝不把异常抛给调用方（抛出去等于把一次工具调用变成一次会话级错误）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { DEFAULT_PRICE_TABLE, priceUsage, ratesAt, isPeakAt, normalizeUsage, totalTokensOf, ZERO_BUCKETS } from './src/model-prices.js'
import { rankStickers, ensureStickerIndex, EMOTION_KEYS } from './src/sticker-semantics.js'
import { discoverDshBaseUrl, probeDshBaseUrl, listeningLoopbackPorts, isLoopbackBaseUrl } from './src/dsh-port.js'
import { fileStamp, isStale } from './src/config-stamps.js'
import {
  ALERT_RATIO,
  SCOPES,
  SCOPE_LABELS,
  allRatios,
  budgetFileOf,
  localDayKey as budgetLocalDayKey,
  localDayStart as budgetLocalDayStart,
  normalizeUsage as budgetNormalizeUsage,
  readBudget,
} from './src/token-budget.js'
import {
  SLANG_STATUS,
  buildExtractionPrompt,
  buildSlangContext,
  capSlangEntries,
  createSlangEntry,
  loadSlang,
  saveSlang,
  upsertSlangEntry,
} from './src/slang-learner.js'

export const name = 'dsh-surf-ports'
export const inject = ['tools']

// ── 路径 ────────────────────────────────────────────────────────────────────

function dshHome() {
  for (const key of ['DSH_HOME', 'DSH_HOME_BETA']) {
    const v = process.env[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const beta = join(homedir(), '.dsh-beta')
  return existsSync(beta) ? beta : join(homedir(), '.dsh')
}

/** 本插件的数据根：**只写这一个目录**，不碰任何既有插件的状态。 */
function dataRoot() {
  const dir = join(dshHome(), 'surf-ports')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const slangFile = () => join(dataRoot(), 'slang.json')
const ledgerFile = () => join(dataRoot(), 'token-ledger.jsonl')
const snapshotRoot = () => join(dataRoot(), 'snapshots')

function errText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err)
}

function readJsonLines(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// ── 1) slang_lexicon ────────────────────────────────────────────────────────

/**
 * 黑话表：**不自己调模型**。
 *
 * 上游靠一个 learner 会话去抽候选，我们这边没有那个常驻进程，所以拆成三步让调用方接：
 *   action=prompt  → 返回 buildExtractionPrompt 拼好的提示词（交给任意一次模型回合）
 *   action=learn   → 把模型回的那段 JSON 交回来（parseExtractionJson 在调用侧做，这里接数组）
 *   action=context → 返回可以直接放进上下文的「群聊黑话表」文本（有上限）
 * 这样插件零 LLM 依赖、零定时器，判断仍在纯逻辑里。
 */
async function slangLexicon(args) {
  const action = String(args?.action ?? 'list')
  if (action === 'list') {
    const entries = loadSlang(slangFile())
    const confirmed = entries.filter((e) => e.status === SLANG_STATUS.CONFIRMED)
    const candidates = entries.filter((e) => e.status === SLANG_STATUS.CANDIDATE)
    return {
      ok: true,
      total: entries.length,
      confirmed: confirmed.length,
      candidates: candidates.length,
      // 候选单独列：它们**不会被注入上下文**（buildSlangContext 只取 confirmed），
      // 但人要看得到——否则自动任务学进来的东西就成了黑箱。
      candidateEntries: candidates.slice(-20).map((e) => ({ content: e.content, meaning: e.meaning, hits: e.evidence?.length ?? 0 })),
      entries: entries.slice(-30).map((e) => ({
        content: e.content,
        meaning: e.meaning,
        status: e.status,
        hits: e.evidence?.length ?? 0,
      })),
    }
  }

  if (action === 'promote') {
    // 人审过之后把候选升成 confirmed：这是「自动学进来」与「真的敢用」之间的唯一一道门。
    const key = String(args?.content ?? '').trim()
    if (!key) return { ok: false, error: 'content 必填（要升级的黑话原文）' }
    const entries = loadSlang(slangFile())
    const hit = entries.find((e) => e.content === key)
    if (!hit) return { ok: false, error: `库里没有「${key}」` }
    if (hit.status === SLANG_STATUS.CONFIRMED) return { ok: true, already: true, content: key }
    hit.status = SLANG_STATUS.CONFIRMED
    hit.updatedAt = new Date().toISOString()
    saveSlang(slangFile(), entries)
    return { ok: true, promoted: key }
  }

  if (action === 'prompt') {
    const messages = Array.isArray(args?.messages)
      ? args.messages
      : String(args?.text ?? '')
          .split('\n')
          .filter(Boolean)
          .map((text) => ({ senderName: '', text }))
    if (!messages.length) return { ok: false, error: 'messages 或 text 必填（要分析的群聊原文）' }
    return { ok: true, prompt: buildExtractionPrompt(messages) }
  }

  if (action === 'learn') {
    const incoming = Array.isArray(args?.entries) ? args.entries : []
    if (!incoming.length) return { ok: false, error: 'entries 必填（确认过的黑话数组）' }
    let next = loadSlang(slangFile())
    const added = []
    for (const raw of incoming) {
      const content = String(raw?.content ?? raw?.word ?? '').trim()
      if (!content) continue
      // upsertSlangEntry 返回的是 `{ entries, entry, created }` 包壳（就地改数组），
      // 不是数组本身 —— 直接把它当 entries 用会把整个库写成空（第一次跑就栽在这）。
      const res = upsertSlangEntry(next, content, {
        meaning: raw?.meaning ?? '',
        usage: raw?.usage ?? '',
        example: raw?.example ?? '',
        risk: raw?.risk ?? '',
        status: raw?.status ?? SLANG_STATUS.CONFIRMED,
        source: 'agent',
        countIncrement: 1,
      })
      next = Array.isArray(res?.entries) ? res.entries : next
      if (res?.created) added.push(content)
    }
    // capSlangEntries 同样返回 `{ entries, dropped }`
    const capped = capSlangEntries(next)
    next = Array.isArray(capped?.entries) ? capped.entries : next
    saveSlang(slangFile(), next)
    return { ok: true, added, total: next.length, dropped: capped?.dropped ?? 0 }
  }

  if (action === 'context') {
    const entries = loadSlang(slangFile())
    const text = buildSlangContext(entries, Number(args?.max) || 8)
    return { ok: true, text, used: text ? text.split('\n').length : 0 }
  }

  if (action === 'forget') {
    const key = String(args?.content ?? '').trim()
    if (!key) return { ok: false, error: 'content 必填（要忘掉的黑话原文）' }
    const entries = loadSlang(slangFile())
    const next = entries.filter((e) => e.content !== key)
    saveSlang(slangFile(), next)
    return { ok: true, removed: entries.length - next.length, total: next.length }
  }

  return { ok: false, error: `未知 action: ${action}（可用 list / prompt / learn / context / forget）` }
}

// ── 2) token_usage ──────────────────────────────────────────────────────────

/**
 * 用量账本：**只做记录与折算，不自己抓数**。
 *
 * 为什么不是"自动读会话日志"：DSH 的 tokenUsage 在 `session/follow` 的 snapshot 投影里，
 * 而会话日志是 zstd 压缩的 jsonl——插件侧要拿全量历史代价大、且投影语义会漂。
 * 所以这一版收「已经数出来的数」，由调用方（或以后的定时任务）喂。
 * 口径与 dsh-token-meter 一致：同 (session,turn,step,retry) 后到覆盖先到。
 */
async function tokenUsage(args) {
  const action = String(args?.action ?? 'report')

  if (action === 'record') {
    const usage = normalizeUsage(args?.usage ?? {})
    const row = {
      at: Number(args?.at) || Date.now(),
      session: String(args?.session ?? 'default'),
      turn: Number(args?.turn) || 0,
      step: Number(args?.step) || 0,
      retry: Number(args?.retry) || 0,
      model: String(args?.model ?? ''),
      usage,
    }
    const path = ledgerFile()
    const existing = readJsonLines(path)
    // 幂等：同 (session,turn,step,retry) 覆盖，不累加（重连会重发同一批事件）
    const key = (r) => `${r.session}|${r.turn}|${r.step}|${r.retry}`
    const map = new Map(existing.map((r) => [key(r), r]))
    map.set(key(row), row)
    writeFileSync(path, [...map.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return { ok: true, rows: map.size, saved: row }
  }

  if (action === 'prices') {
    const model = String(args?.model ?? 'deepseek-v4.1-flash')
    const at = Number(args?.at) || Date.now()
    return {
      ok: true,
      model,
      peakNow: isPeakAt(at, DEFAULT_PRICE_TABLE),
      rates: ratesAt(model, at, DEFAULT_PRICE_TABLE),
      tableVersion: DEFAULT_PRICE_TABLE.version ?? '(未标注)',
    }
  }

  if (action === 'clear') {
    const path = ledgerFile()
    if (existsSync(path)) rmSync(path, { force: true })
    return { ok: true, cleared: true }
  }

  // ── 额度闸（P4 迁移自 surfcore token-budget）──────────────────────────────
  // 账本只回答"花了多少"，额度才回答"该不该省"。两者缺一个，账本永远只是账单。
  if (action === 'budget') {
    const now = Number(args?.at) || Date.now()
    const dir = join(dshHome(), 'surf-ports')
    const limits = readBudget(dir)
    const dayStart = budgetLocalDayStart(now)
    const dayRows = readJsonLines(ledgerFile()).filter((r) => (Number(r.at) || 0) >= dayStart)
    let cost = 0
    let tokens = 0
    let unpriced = 0
    for (const r of dayRows) {
      for (const k of Object.keys(ZERO_BUCKETS)) tokens += Number(r.usage?.[k]) || 0
      const priced = priceUsage(r.usage ?? {}, { model: r.model, at: r.at })
      const rowCost = Number(priced?.cost?.total)
      if (Number.isFinite(rowCost)) cost += rowCost
      else unpriced += 1
    }
    // 我们的账本不区分 qq/bili/other（DSH 侧只有一个来源），所以全部计入 other，
    // total 由 totalsOf 自动累加 —— 不假装有多分类数据。
    const usage = budgetNormalizeUsage({ other: { cost, tokens } })
    const ratios = allRatios(usage, limits)
    const scopeRows = SCOPES.map((scope) => {
      const r = ratios[scope] ?? {}
      const worst = Math.max(r.cny ?? 0, r.tokens ?? 0)
      return {
        scope,
        label: SCOPE_LABELS[scope] ?? scope,
        usedCostCny: Number((usage[scope]?.cost ?? 0).toFixed(4)),
        usedTokens: usage[scope]?.tokens ?? 0,
        limitCny: limits[scope]?.cny ?? null,
        limitTokens: limits[scope]?.tokens ?? null,
        ratioCny: r.cny,
        ratioTokens: r.tokens,
        // over=超了要拦；near=到提醒线；null=没设额度或没用量
        state: worst >= 1 ? 'over' : worst >= ALERT_RATIO ? 'near' : worst > 0 ? 'ok' : null,
      }
    })
    return {
      ok: true,
      day: budgetLocalDayKey(now),
      rows: dayRows.length,
      unpriced,
      budgetFile: budgetFileOf(dir),
      alertRatio: ALERT_RATIO,
      scopes: scopeRows,
      over: scopeRows.filter((s) => s.state === 'over').map((s) => s.label),
      near: scopeRows.filter((s) => s.state === 'near').map((s) => s.label),
    }
  }

  // 未知 action 必须显式报错：否则会静默落到下面的 report 分支，假装成功。
  if (action !== 'report') {
    return { ok: false, error: `未知 action: ${action}（可用 record / report / prices / budget / clear）` }
  }

  // report
  const rows = readJsonLines(ledgerFile())
  if (!rows.length) return { ok: true, rows: 0, note: '账本为空：请先用 action=record 记一条' }
  const bySession = new Map()
  let grand = { ...ZERO_BUCKETS }
  let cost = 0
  let unpriced = 0
  for (const r of rows) {
    const key = `${r.session} · ${r.model || '未知模型'}`
    const acc = bySession.get(key) ?? { buckets: { ...ZERO_BUCKETS }, cost: 0, turns: 0 }
    for (const k of Object.keys(ZERO_BUCKETS)) acc.buckets[k] += Number(r.usage?.[k]) || 0
    // priceUsage 返回 `{ rates, cost: { cacheHit, cacheMiss, cacheWrite, output, total } }`
    // —— cost 是**对象**不是数字，取错字段会让整张报表金额恒为 0 且不报错。
    const priced = priceUsage(r.usage ?? {}, { model: r.model, at: r.at })
    const rowCost = Number(priced?.cost?.total)
    if (Number.isFinite(rowCost)) acc.cost += rowCost
    else unpriced += 1
    acc.turns += 1
    bySession.set(key, acc)
    for (const k of Object.keys(ZERO_BUCKETS)) grand[k] += Number(r.usage?.[k]) || 0
  }
  const sessions = [...bySession.entries()].map(([k, v]) => ({
    key: k,
    turns: v.turns,
    tokens: totalTokensOf(v.buckets),
    costCny: Number(v.cost.toFixed(4)),
  }))
  sessions.sort((a, b) => b.costCny - a.costCny)
  cost = sessions.reduce((s, x) => s + x.costCny, 0)
  return {
    ok: true,
    rows: rows.length,
    tokens: totalTokensOf(grand),
    buckets: grand,
    costCny: Number(cost.toFixed(4)),
    unpriced,
    sessions,
  }
}

// ── 3) sticker_best ─────────────────────────────────────────────────────────

let stickerCache = null

/** nekowhale 的元数据 → sticker-semantics 要的 entries 形状。读一次就缓存（322 条，不重读）。 */
function loadStickerEntries() {
  if (stickerCache) return stickerCache
  const candidates = [
    join(dshHome(), 'profiles', 'desktop', 'node_modules', 'dsh-nekowhale-stickers', 'meta', 'nekowhale.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const meta = JSON.parse(readFileSync(p, 'utf8'))
      const list = Array.isArray(meta.stickers) ? meta.stickers : []
      const entries = list.map((s) => ({
        id: s.id,
        emotion: s.emotion,
        tags: Array.isArray(s.tags) ? s.tags : [],
        keywords: Array.isArray(s.tags) ? s.tags : [],
        content: String(s.desc ?? ''),
        desc: String(s.use ?? ''),
        createdAt: '',
        no: 0,
      }))
      stickerCache = ensureStickerIndex(entries).entries
      return stickerCache
    } catch {
      // 元数据坏了就当没有：宁可报"挑不出来"，也不要拿半份库乱推
    }
  }
  stickerCache = []
  return stickerCache
}

/**
 * 表情「用过」记账（迁移自 surfcore sticker-lib 的 markStickerUsed 思路）。
 *
 * 为什么需要它：挑表情靠打分，但"这张我上一条刚发过"是**任何打分都算不出来的**——
 * 库里同一情绪的几张图分数几乎一样，于是反复挑中同一张，人一眼就看出来是复读。
 * 这个账本把"最近发过"变成可查的事实：挑的时候直接排除，不靠记性。
 */
function stickerUsageFile() {
  return join(dshHome(), 'surf-ports', 'sticker-usage.json')
}

function readStickerUsage() {
  const file = stickerUsageFile()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 记一批名字（`name → 时间戳`），顺手裁掉 30 天前的，别让文件无限长。 */
function markStickersUsed(names) {
  const now = Date.now()
  const map = readStickerUsage()
  for (const n of names) if (n) map[n] = now
  const cutoff = now - 30 * 24 * 60 * 60 * 1000
  for (const [k, v] of Object.entries(map)) if (!(Number(v) >= cutoff)) delete map[k]
  const file = stickerUsageFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
  return map
}

/** 最近 days 天内发过的名字。 */
function recentlyUsedStickers(days = 5) {
  const cutoff = Date.now() - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000
  return new Set(Object.entries(readStickerUsage()).filter(([, at]) => Number(at) >= cutoff).map(([name]) => stickerKey(name)))
}

/**
 * 表情的规范键 = **最后一段名字**（`大肥鱼/8N09_哈欠` → `8N09_哈欠`）。
 *
 * 两个坑叠在一起，都是"看起来正常"的那种：
 *  ① `loadStickerEntries` 造的条目没有 `name`，只有 `id`，而且 id 带包名前缀；
 *  ② `sticker_send` / `sticker_search` 用的却是短名。
 * 于是拿 `e.name` 过滤 = undefined（永不排除），拿短名记账 = 与长 id 对不上
 * （记了也不排除）。两边统一走这个函数，谁写进账本都能互相认出来。
 */
const stickerKey = (v) => String(v?.name ?? v?.id ?? v ?? '').trim().split('/').pop()

async function stickerBest(args) {
  const context = String(args?.context ?? '').trim()
  if (!context) return { ok: false, error: 'context 必填（当前聊天语境，几句话就够）' }
  const entries = loadStickerEntries()
  if (!entries.length) return { ok: false, error: '读不到 nekowhale 表情元数据（路径变了？）' }
  // 排除最近发过的（默认 5 天），除非显式 allowRepeat
  const days = Number.isFinite(Number(args?.avoidDays)) ? Number(args.avoidDays) : 5
  const recent = args?.allowRepeat ? new Set() : recentlyUsedStickers(days)
  const pool = recent.size ? entries.filter((e) => !recent.has(stickerKey(e))) : entries
  const picked = rankStickers(pool, context, {
    topK: Math.max(1, Math.min(10, Number(args?.topK) || 3)),
    minScore: Number.isFinite(Number(args?.minScore)) ? Number(args.minScore) : 0.34,
  })
  // 记一笔：传了 used 就记 used（真发出去的那张），否则记第一名（绝大多数情况就是它）。
  const toMark = Array.isArray(args?.used) ? args.used.map(stickerKey).filter(Boolean) : []
  const autoName = stickerKey(picked[0])
  const marked = toMark.length ? toMark : autoName ? [autoName] : []
  if (marked.length && !args?.noMark) markStickersUsed(marked)
  return {
    ok: true,
    library: entries.length,
    excluded: recent.size,
    avoidedDays: recent.size ? days : 0,
    marked,
    emotions: EMOTION_KEYS.length,
    picked,
  }
}

// ── 4) file_snapshot ────────────────────────────────────────────────────────

/**
 * 文件快照/回档：给"改错了会很难受"的文件用（人格卡、AGENTS.md、预设）。
 *
 * 不做自动巡检、不做定时：DSH 重启后插件随时可能不在，靠它守文件不可靠。
 * 只在人明确要求「存一下 / 退回刚才那版」时动。
 */
async function dshEnv(args) {
  const action = String(args?.action ?? 'discover')

  if (action === 'discover') {
    // 桌面端每次启动挑一个空闲回环端口（实测 28918 → 15016 → 41742 → 42212 → 61765），
    // 任何写死了端口的链接/配置在重启后必然失效。这里现场探。
    const base = await discoverDshBaseUrl()
    return {
      ok: Boolean(base),
      baseUrl: base ?? null,
      hint: base ? '' : '没探到 DSH：非 Windows 平台只做 HTTP 探活，或进程名不含 harness/dsh',
    }
  }

  if (action === 'probe') {
    const url = String(args?.url ?? '').trim()
    if (!url) return { ok: false, error: 'url 必填' }
    return { ok: true, url, alive: await probeDshBaseUrl(url), loopback: isLoopbackBaseUrl(url) }
  }

  if (action === 'ports') {
    return { ok: true, ports: listeningLoopbackPorts() }
  }

  if (action === 'stamp') {
    const file = String(args?.file ?? '').trim()
    if (!file) return { ok: false, error: 'file 必填' }
    const current = fileStamp(file)
    const provided = args?.compareTo === undefined || args?.compareTo === null ? null : String(args.compareTo)
    return {
      ok: Boolean(current),
      file,
      stamp: current || null,
      // 没带戳 = 旧客户端，按"不过期"放行（兼容），不是"文件没问题"
      stale: provided === null ? null : isStale(provided, current),
      note: current ? '' : '文件不存在或读不到',
    }
  }

  return { ok: false, error: `未知 action: ${action}（discover / probe / ports / stamp）` }
}

async function fileSnapshot(args) {
  const action = String(args?.action ?? 'list')
  const files = Array.isArray(args?.files) ? args.files.filter((f) => typeof f === 'string' && f.trim()) : []

  if (action === 'save') {
    if (!files.length) return { ok: false, error: 'files 必填（要快照的文件绝对路径数组）' }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = join(snapshotRoot(), ts)
    mkdirSync(dir, { recursive: true })
    const saved = []
    const missing = []
    for (const f of files) {
      if (!existsSync(f)) {
        missing.push(f)
        continue
      }
      const dest = join(dir, basename(f))
      copyFileSync(f, dest)
      const sha256 = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)
      saved.push({ file: f, copy: basename(f), sha256 })
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ts, note: String(args?.note ?? ''), saved, missing }, null, 2), 'utf8')
    return { ok: true, snapshot: ts, saved, missing }
  }

  if (action === 'list') {
    const root = snapshotRoot()
    if (!existsSync(root)) return { ok: true, snapshots: [] }
    const dirs = readdirSync(root).sort().reverse()
    return {
      ok: true,
      snapshots: dirs.slice(0, 20).map((d) => {
        const mf = join(root, d, 'manifest.json')
        let manifest = null
        try {
          manifest = JSON.parse(readFileSync(mf, 'utf8'))
        } catch {
          manifest = null
        }
        return { snapshot: d, note: manifest?.note ?? '', files: (manifest?.saved ?? []).length, missing: (manifest?.missing ?? []).length }
      }),
    }
  }

  if (action === 'restore') {
    const which = String(args?.snapshot ?? '').trim()
    if (!which) return { ok: false, error: 'snapshot 必填（先 action=list 看有哪些）' }
    const dir = join(snapshotRoot(), which)
    if (!existsSync(dir)) return { ok: false, error: `找不到快照 ${which}` }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      return { ok: false, error: 'manifest 损坏，拒绝回档（不敢拿半份快照去覆盖文件）' }
    }
    // 回档前先给「现在」存一份 —— 否则回错了就再也回不来
    const pre = new Date().toISOString().replace(/[:.]/g, '-')
    const preDir = join(snapshotRoot(), `pre-restore-${pre}`)
    mkdirSync(preDir, { recursive: true })
    const restored = []
    for (const item of manifest.saved ?? []) {
      const src = join(dir, item.copy)
      if (!existsSync(src)) continue
      if (existsSync(item.file)) copyFileSync(item.file, join(preDir, basename(item.file)))
      copyFileSync(src, item.file)
      restored.push(item.file)
    }
    return { ok: true, restored, safetySnapshot: `pre-restore-${pre}` }
  }

  return { ok: false, error: `未知 action: ${action}（可用 save / list / restore）` }
}

// ── 渲染（DSH tools.register 的硬要求：render(args, value) → content blocks）──

function renderText(lines) {
  return [{ type: 'text', text: lines.join('\n') }]
}

const RENDERERS = {
  dsh_env(_a, v) {
    if (!v?.ok && !v?.ports && !v?.stamp) return renderText([`DSH 环境：${v?.error ?? v?.hint ?? '探测失败'}`])
    if (v.baseUrl !== undefined) {
      return renderText([
        v.baseUrl ? `当前 DSH：${v.baseUrl}` : '没探到正在运行的 DSH',
        ...(v.hint ? [`说明：${v.hint}`] : []),
        '⚠ 桌面端每次启动换端口，任何写死的链接在重启后都会失效——要用的时候现探，别缓存。',
      ])
    }
    if (v.alive !== undefined) return renderText([`${v.url} → ${v.alive ? '活着（是 DSH）' : '不是 DSH / 没响应'}${v.loopback ? ' · 回环地址' : ''}`])
    if (v.ports) return renderText([`回环监听端口 ${v.ports.length} 个`, ...v.ports.slice(0, 20).map((p) => `  ${p.port}  pid=${p.pid}`)])
    return renderText([
      `${v.file}`,
      `版本戳 ${v.stamp ?? '（读不到）'}`,
      v.stale === null ? '没带 compareTo：只给当前戳' : v.stale ? '已过期：文件被别处改过，别整份回写' : '没过期',
    ])
  },
  slang_lexicon(_a, v) {
    if (!v?.ok) return renderText([`黑话表：${v?.error ?? '失败'}`])
    if (v.promoted || v.already) return renderText([v.already ? `「${v.content}」已经是 confirmed，不用再升` : `已升级为 confirmed：${v.promoted}`])
    if (v.prompt) return renderText(['黑话抽取提示词（交给模型回合）：', v.prompt.slice(0, 1500)])
    if (v.text !== undefined) return renderText([`可注入的黑话表（${v.used} 行）：`, v.text || '（空：还没确认过任何黑话）'])
    if (v.added) return renderText([`新学 ${v.added.length} 条：${v.added.join('、')}`, `总计 ${v.total} 条`])
    return renderText([
      `黑话表 ${v.total} 条（已确认 ${v.confirmed} · 候选 ${v.candidates ?? 0}）`,
      ...(v.candidateEntries ?? []).length ? ['候选（未注入，需 promote 才生效）：', ...(v.candidateEntries ?? []).map((e) => `  ? ${e.content}${e.meaning ? ` = ${e.meaning}` : ''}`)] : [],
      ...(v.entries ?? []).slice(-10).map((e) => `  · ${e.content}${e.meaning ? ` = ${e.meaning}` : ''} [${e.status}]`),
    ])
  },
  token_usage(_a, v) {
    if (!v?.ok) return renderText([`用量：${v?.error ?? '失败'}`])
    if (v.rates) return renderText([`模型 ${v.model} · ${v.peakNow ? '峰时' : '谷时'}`, `价目表 ${v.tableVersion}`, JSON.stringify(v.rates)])
    if (v.scopes) {
      const ICON = { over: '⛔', near: '⚠️', ok: '·', }
      return renderText([
        `额度 · ${v.day}（今天 ${v.rows} 条采样${v.unpriced ? `，${v.unpriced} 条无价目` : ''}）`,
        ...v.scopes.filter((s) => s.state).map((s) => {
          const bits = []
          if (s.limitCny !== null) bits.push(`¥${s.usedCostCny}/¥${s.limitCny}（${Math.round((s.ratioCny ?? 0) * 100)}%）`)
          if (s.limitTokens !== null) bits.push(`${s.usedTokens}/${s.limitTokens} token（${Math.round((s.ratioTokens ?? 0) * 100)}%）`)
          return `  ${ICON[s.state] ?? '·'} ${s.label}：${bits.join(' · ') || '未设额度'}`
        }),
        v.scopes.every((s) => !s.state)
          ? `没设任何额度（${v.budgetFile} 里填 {other:{cny:数字}} 才开始算）`
          : v.over.length ? `已超：${v.over.join('、')}` : v.near.length ? `接近上限（≥${Math.round(v.alertRatio * 100)}%）：${v.near.join('、')}` : '都在额度内',
      ])
    }
    if (v.saved) return renderText([`已记一条：${v.saved.session} turn${v.saved.turn} · 共 ${totalTokensOf(v.saved.usage)} token（账本 ${v.rows} 条）`])
    if (!v.rows) return renderText([v.note ?? '账本为空'])
    return renderText([
      `共 ${v.rows} 条采样 · ${v.tokens} token · 折合 ¥${v.costCny}${v.unpriced ? `（${v.unpriced} 条无价目）` : ''}`,
      ...v.sessions.map((s) => `  · ${s.key}：${s.turns} 轮 · ${s.tokens} token · ¥${s.costCny}`),
    ])
  },
  sticker_best(_a, v) {
    if (!v?.ok) return renderText([`表情：${v?.error ?? '失败'}`])
    if (!v.picked?.length) return renderText([`库 ${v.library} 张，语境里没挑出够分的（可以调低 minScore）`])
    return renderText([
      `库 ${v.library} 张${v.excluded ? ` · 已排除最近 ${v.avoidedDays} 天发过的 ${v.excluded} 张` : ''} · 挑出 ${v.picked.length} 张：`,
      ...v.picked.map((p) => `  ${p.no ? `#${String(p.no).padStart(2, '0')} ` : ''}${p.id} [${p.emotionLabel}] ${Math.round((p.score ?? 0) * 100)}% — ${p.reason ?? ''}`),
    ])
  },
  file_snapshot(_a, v) {
    if (!v?.ok) return renderText([`快照：${v?.error ?? '失败'}`])
    if (v.snapshot && v.saved) {
      return renderText([`已快照 ${v.snapshot}：${v.saved.length} 个文件${v.missing?.length ? `，缺 ${v.missing.length} 个` : ''}`, ...(v.saved ?? []).map((s) => `  · ${s.file} (${s.sha256})`)])
    }
    if (v.snapshots) return renderText([`快照 ${v.snapshots.length} 份：`, ...v.snapshots.map((s) => `  · ${s.snapshot} · ${s.files} 个文件${s.note ? ` · ${s.note}` : ''}`)])
    return renderText([`已回档 ${v.restored?.length ?? 0} 个文件`, `回档前已另存：${v.safetySnapshot}`])
  },
}

function mk(name, description, parameters, fn) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: RENDERERS[name],
    },
    async execute(args) {
      try {
        return await fn(args ?? {})
      } catch (err) {
        return { ok: false, error: errText(err) }
      }
    },
  }
}

export function apply(ctx) {
  const tools = ctx.get('tools', false)
  if (!tools || typeof tools.register !== 'function') {
    try {
      ctx?.logger?.warn?.('[surf-ports] tools 服务不可用：不注册任何工具')
    } catch {
      /* 日志都拿不到就算了，不抛 */
    }
    return
  }

  tools.register(
    mk(
      'slang_lexicon',
      '群聊黑话表：学会主人们的黑话，再在聊天时看懂它。action=list 看已有的（候选会被单独列出，但不参与注入）；prompt 拿抽取提示词（交给模型去读群聊原文）；learn 把确认过的黑话存进来（可传 status:"candidate" 只登记候选）；promote 把一条候选升成 confirmed（人工复核后）；context 拿一段可直接放进上下文的黑话表；forget 忘掉一条。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'prompt', 'learn', 'promote', 'context', 'forget'] },
          text: { type: 'string', description: 'action=prompt 时的群聊原文（按行切）' },
          messages: { type: 'array', description: 'action=prompt 时的消息数组 [{senderName,text}]', items: { type: 'object' } },
          entries: { type: 'array', description: 'action=learn 时的黑话数组 [{content,meaning,usage,example,risk}]', items: { type: 'object' } },
          content: { type: 'string', description: 'action=forget 时要忘掉的黑话原文' },
          max: { type: 'number', description: 'action=context 时最多几条（默认 8）' },
        },
        required: ['action'],
      },
      slangLexicon,
    ),
  )

  tools.register(
    mk(
      'token_usage',
      'token 用量账本与费用折算（按会话×模型聚合，含峰谷价）。action=record 记一条采样（同 session/turn/step/retry 幂等覆盖）；report 出报表（token + 人民币）；prices 看某模型当前是峰时还是谷时及单价；clear 清空账本。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['record', 'report', 'prices', 'clear'] },
          session: { type: 'string', description: 'record 用：会话 id' },
          turn: { type: 'number', description: 'record 用：轮次' },
          step: { type: 'number', description: 'record 用：步数' },
          retry: { type: 'number', description: 'record 用：重试轴（重试的请求另算一次）' },
          model: { type: 'string', description: 'record/prices 用：模型名' },
          at: { type: 'number', description: 'record/prices 用：时间戳 ms（默认现在）' },
          usage: {
            type: 'object',
            description: 'record 用：{cacheMiss,cacheHit,cacheWrite,output,reasoning}',
            properties: {
              cacheMiss: { type: 'number' },
              cacheHit: { type: 'number' },
              cacheWrite: { type: 'number' },
              output: { type: 'number' },
              reasoning: { type: 'number' },
            },
          },
        },
        required: ['action'],
      },
      tokenUsage,
    ),
  )

  tools.register(
    mk(
      'sticker_best',
      '按当前聊天语境从表情库里挑最贴的 1~3 张（情绪相近 0.46 + 内容相近 0.38 + 关键词 0.16）。给几句上下文，比只按情绪词搜更准。会自动排除最近 5 天发过的（库里同情绪几张分数几乎一样，"刚发过"是打分算不出来的），并在返回时把挑中的那张记进使用账本——真的发了别的那张，就传 used 明确记。',
      {
        type: 'object',
        properties: {
          context: { type: 'string', description: '当前聊天语境：最近几条消息或你想表达的意思' },
          topK: { type: 'number', description: '挑几张（1~10，默认 3）' },
          minScore: { type: 'number', description: '最低分（默认 0.34，挑不出来就调低）' },
          used: { type: 'array', items: { type: 'string' }, description: '真的发出去的名字（记进账本）；不传就记第一名' },
          avoidDays: { type: 'number', description: '排除最近几天发过的（默认 5，0 = 不排除）' },
          allowRepeat: { type: 'boolean', description: 'true = 允许重复发同一张（用户明确要同一张时用）' },
          noMark: { type: 'boolean', description: 'true = 只挑不记账' },
        },
        required: ['context'],
      },
      stickerBest,
    ),
  )

  tools.register(
    mk(
      'dsh_env',
      '看「当前那只 DSH」的环境事实：action=discover 探测它现在监听的回环端口（桌面端每次启动都换端口，写死链接必然失效）；probe 判断某个地址上是不是活着的 DSH；ports 列出回环监听端口；stamp 取一个文件的「版本戳」（mtime+size），可选 compareTo 判断它有没有被别处改过（配置整份回写覆盖别人修改的经典坑）。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discover', 'probe', 'ports', 'stamp'] },
          url: { type: 'string', description: 'probe 用：要探的 base url' },
          file: { type: 'string', description: 'stamp 用：文件绝对路径' },
          compareTo: { type: 'string', description: 'stamp 用：提交时带的版本戳（不传就只返回当前戳）' },
        },
        required: ['action'],
      },
      dshEnv,
    ),
  )

  tools.register(
    mk(
      'file_snapshot',
      '文件快照与回档：给人格卡、AGENTS.md、预设这类"改错了会很难受"的文件用。action=save 存一份（files 传绝对路径数组）；list 看有哪些；restore 退回某一份（回档前会自动再存一份当前状态，回错了还能回来）。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'list', 'restore'] },
          files: { type: 'array', items: { type: 'string' }, description: 'save 用：要快照的文件绝对路径' },
          note: { type: 'string', description: 'save 用：一句话备注' },
          snapshot: { type: 'string', description: 'restore 用：快照 id（list 里有）' },
        },
        required: ['action'],
      },
      fileSnapshot,
    ),
  )
}
