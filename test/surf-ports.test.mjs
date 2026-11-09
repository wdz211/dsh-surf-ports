/**
 * surf-ports 的自测：**不测「函数返回了东西」，测「工具真的能注册、执行、渲染」**。
 *
 * 做法是拿一个假的 ctx 骗过 apply()，把它注册的工具抓出来，再逐个调用 execute ——
 * 这样连 output.render 的入参顺序（args, value）都会走到，能提前发现
 * "render 读第一个参数" 那类只有真跑才会炸的错。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { apply } = await import('../index.js')

/** 假 ctx：只提供 ctx.get('tools')，收集注册的工具。 */
function boot() {
  const tools = new Map()
  const ctx = {
    get(service) {
      if (service !== 'tools') return false
      return {
        register(def) {
          tools.set(def.name, def)
        },
      }
    },
    logger: { warn() {}, info() {} },
  }
  apply(ctx)
  return tools
}

/** 隔离数据根：所有会落盘的 action 都写到临时目录，绝不碰真实 ~/.dsh-beta。
 *
 * 必须 **await** fn：写成 `return fn(dir)` 再在 finally 里清理，异步体还没跑完
 * 环境就被拆了 —— 第一次写这个helper 时四个用例就是这么一起挂的。
 */
async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'surf-ports-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(dir, { recursive: true, force: true })
  }
}

test('apply() 注册了五个工具，且每个都有 output.render', () => {
  const tools = boot()
  assert.deepEqual([...tools.keys()].sort(), ['dsh_env', 'file_snapshot', 'slang_lexicon', 'sticker_best', 'token_usage'].sort())
  for (const [name, def] of tools) {
    assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
    assert.equal(typeof def.output?.render, 'function', `${name} 缺 output.render（DSH 会直接 TypeError）`)
    assert.ok(def.parameters?.type === 'object', `${name} 缺 parameters schema`)
  }
})

test('render 必须吃 (args, value) 两参并返回 content blocks —— 传错参数不能崩', async () => {
  const tools = boot()
  for (const [name, def] of tools) {
    const value = await def.execute(name === 'file_snapshot' ? { action: 'list' } : { action: 'list' })
    const blocks = def.output.render({}, value)
    assert.ok(Array.isArray(blocks), `${name} render 没返回数组`)
    assert.equal(blocks[0]?.type, 'text', `${name} render 首个 block 不是 text`)
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('slang_lexicon：学进去 → 看得到 → 能注入 → 能忘掉', async () => {
  await withTempHome(async () => {
    const tools = boot()
    const slang = tools.get('slang_lexicon')

    const empty = await slang.execute({ action: 'list' })
    assert.equal(empty.ok, true)
    assert.equal(empty.total, 0)

    const learned = await slang.execute({
      action: 'learn',
      entries: [{ content: '牢大', meaning: '调侃某位主播的自称' }, { content: '绝绝子', meaning: '表示非常好' }],
    })
    assert.equal(learned.ok, true)
    assert.equal(learned.added.length, 2)

    const listed = await slang.execute({ action: 'list' })
    assert.equal(listed.total, 2)

    const ctxText = await slang.execute({ action: 'context', max: 5 })
    assert.equal(ctxText.ok, true)
    assert.ok(ctxText.text.includes('牢大'), '注入文本里必须真的带上黑话')

    const forgot = await slang.execute({ action: 'forget', content: '牢大' })
    assert.equal(forgot.removed, 1)
    assert.equal((await slang.execute({ action: 'list' })).total, 1)
  })
})

test('slang_lexicon：prompt 要能把多行原文变成抽取提示词', async () => {
  const tools = boot()
  const slang = tools.get('slang_lexicon')
  const out = await slang.execute({ action: 'prompt', text: 'A: 这个皮肤绝绝子\nB: 牢大说得对' })
  assert.equal(out.ok, true)
  assert.ok(out.prompt.length > 20)
  assert.equal((await slang.execute({ action: 'prompt' })).ok, false, '没有原文时必须报错，不能编')
})

test('token_usage：记一条、同键幂等覆盖、能折出金额', async () => {
  await withTempHome(async () => {
    const tools = boot()
    const usage = tools.get('token_usage')

    const rec = await usage.execute({
      action: 'record',
      session: 'session-a',
      turn: 1,
      model: 'deepseek-v4.1-flash',
      at: Date.parse('2026-10-31T03:00:00+08:00'),
      usage: { cacheMiss: 1000, cacheHit: 9000, output: 500 },
    })
    assert.equal(rec.ok, true)
    assert.equal(rec.rows, 1)

    // 同一 (session,turn,step,retry) 再记一次：覆盖，不累加
    const rec2 = await usage.execute({
      action: 'record',
      session: 'session-a',
      turn: 1,
      model: 'deepseek-v4.1-flash',
      at: Date.parse('2026-10-31T03:00:00+08:00'),
      usage: { cacheMiss: 2000, cacheHit: 9000, output: 500 },
    })
    assert.equal(rec2.rows, 1, '重连重发同一批事件时不能变成两行')

    const report = await usage.execute({ action: 'report' })
    assert.equal(report.ok, true)
    assert.equal(report.rows, 1)
    assert.equal(report.tokens, 2000 + 9000 + 500)
    assert.ok(report.costCny > 0, '折出的人民币必须大于 0')
  })
})

test('token_usage：价格查询要说出峰时/谷时', async () => {
  const tools = boot()
  const out = await tools.get('token_usage').execute({ action: 'prices', model: 'deepseek-v4.1-flash' })
  assert.equal(out.ok, true)
  assert.equal(typeof out.peakNow, 'boolean')
  assert.ok(out.rates && typeof out.rates === 'object')
})

/** 真库表情元数据在不在：CI / 干净机器上没装 dsh-nekowhale-stickers，这条只能跳过。 */
function hasStickerLibrary() {
  const home =
    process.env.DSH_HOME ||
    join(process.env.USERPROFILE || process.env.HOME || '', '.dsh-beta')
  return existsSync(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-nekowhale-stickers', 'meta', 'nekowhale.json'))
}

test(
  'sticker_best：真库 322 张里按语境挑得出表情',
  { skip: hasStickerLibrary() ? false : '未安装 dsh-nekowhale-stickers，跳过真库用例' },
  async () => {
    // 这个用例要读真实 nekowhale 元数据 → 不能改 DSH_HOME
    const tools = boot()
    const out = await tools.get('sticker_best').execute({ context: '终于把那个 bug 修好了，好开心，想欢呼一下', topK: 3 })
    assert.equal(out.ok, true, `挑表情失败：${out.error ?? ''}`)
    assert.ok(out.library >= 300, `表情库应 >=300，实际 ${out.library}`)
    assert.ok(out.picked.length >= 1, '开心语境下至少该挑出一张')
    for (const p of out.picked) {
      assert.ok(p.score >= 0.34, `低于 minScore 的不该返回：${p.id} ${p.score}`)
      assert.ok(typeof p.id === 'string' && p.id.length > 0)
    }
  },
)

test('file_snapshot：存 → 改坏了 → 回档，且回档前自动再存一份', async () => {
  await withTempHome(async () => {
    const tools = boot()
    const snap = tools.get('file_snapshot')
    const dir = mkdtempSync(join(tmpdir(), 'snap-target-'))
    const f = join(dir, 'persona.md')
    writeFileSync(f, '原始人格卡', 'utf8')

    const saved = await snap.execute({ action: 'save', files: [f], note: '改之前' })
    assert.equal(saved.ok, true)
    assert.equal(saved.saved.length, 1)

    writeFileSync(f, '改坏了的版本', 'utf8')
    const restored = await snap.execute({ action: 'restore', snapshot: saved.snapshot })
    assert.equal(restored.ok, true)
    assert.equal(readFileSync(f, 'utf8'), '原始人格卡')
    assert.ok(existsSync(join(process.env.DSH_HOME, 'surf-ports', 'snapshots', restored.safetySnapshot)), '回档前必须留一份当前状态')

    const listed = await snap.execute({ action: 'list' })
    assert.ok(listed.snapshots.length >= 2, '应该至少有两份：原快照 + 回档前的安全快照')

    rmSync(dir, { recursive: true, force: true })
  })
})

test('未知 action 一律报错而不是静默成功', async () => {
  const tools = boot()
  for (const name of ['slang_lexicon', 'token_usage', 'file_snapshot']) {
    const out = await tools.get(name).execute({ action: 'nonsense' })
    assert.equal(out.ok, false, `${name} 对未知 action 必须报错`)
    assert.ok(String(out.error ?? '').length > 0)
  }
})

// ── 迁移自 surfcore 的三个小件（2026-10-31）────────────────────────────────

test('config-stamps：文件戳与"是否被别处改过"', async () => {
  const { fileStamp, isStale } = await import('../src/config-stamps.js')
  const dir = mkdtempSync(join(tmpdir(), 'surf-stamp-'))
  const f = join(dir, 'a.json')
  assert.equal(fileStamp(f), '', '文件不存在必须给空串，不能抛')
  writeFileSync(f, '{}', 'utf8')
  const s1 = fileStamp(f)
  assert.match(s1, /^[\d.]+:\d+$/, `戳形状应是 mtime:size，实际 ${s1}`)
  assert.equal(isStale(s1, s1), false, '同一个戳不应判过期')
  writeFileSync(f, '{"a":1}', 'utf8')
  assert.equal(isStale(s1, fileStamp(f)), true, '文件变了必须判过期')
  // 旧客户端没带戳 = 放行，不是"文件没问题"
  assert.equal(isStale('', s1), false)
  assert.equal(isStale(s1, ''), false, '读不到当前戳时不能说过期')
  rmSync(dir, { recursive: true, force: true })
})

test('token-budget：额度从文件读回，比例按人民币与 token 各自算', async () => {
  const { readBudget, writeBudget, normalizeUsage, allRatios, ALERT_RATIO } = await import('../src/token-budget.js')
  const dir = mkdtempSync(join(tmpdir(), 'surf-budget-'))
  writeBudget(dir, { other: { cny: 5 }, total: { tokens: 1_000_000 } })
  const limits = readBudget(dir)
  assert.equal(limits.other.cny, 5)
  assert.equal(limits.total.tokens, 1_000_000)
  const usage = normalizeUsage({ other: { cost: 4.2, tokens: 820_000 } })
  const r = allRatios(usage, limits)
  assert.equal(Math.round(r.other.cny * 100), 84)
  assert.equal(Math.round(r.total.tokens * 100), 82)
  assert.ok(r.other.cny > ALERT_RATIO, '84% 应该已经过了提醒线')
  // 没设额度的一侧必须是 null（不是 0），否则"没额度"会被当成"用完了"
  assert.equal(r.total.cny, null)
  rmSync(dir, { recursive: true, force: true })
})

test('dsh_port：stamp 与 probe 都能跑，且不谎报', async () => {
  const tools = boot()
  const env = tools.get('dsh_env')
  const stamp = await env.execute({ action: 'stamp', file: 'C:/definitely/not/here.json' })
  assert.equal(stamp.ok, false, '文件不存在时 ok 必须是 false')
  assert.equal(stamp.stamp, null)
  const bad = await env.execute({ action: 'probe', url: 'http://127.0.0.1:1' })
  assert.equal(bad.alive, false, '死端口必须报 false，不能因为"探测过了"就报 true')
  const unknown = await env.execute({ action: 'nope' })
  assert.equal(unknown.ok, false, '未知 action 必须报错')
})

test(
  'sticker_best：发过的会被真的排除，而不是只打印"已排除"',
  { skip: hasStickerLibrary() ? false : '未安装 dsh-nekowhale-stickers，跳过真库用例' },
  async () => {
    // 回归 2026-10-31 的静默失效：条目没有 name 字段、id 又带包名前缀，
    // 第一版拿 e.name 过滤恒为 undefined —— 工具照样打印"已排除 N 张"，实际一张没排。
    await withTempHome(async () => {
      const tools = boot()
      const best = tools.get('sticker_best')
      const ctx = { context: '好累 想睡觉 哈欠 熬夜', minScore: 0.2, topK: 5 }

      const first = await best.execute({ ...ctx })
      assert.equal(first.ok, true, `挑表情失败：${first.error}`)
      assert.ok(first.picked.length > 0, '这里应该挑得出表情')
      const target = String(first.picked[0].name ?? first.picked[0].id).split('/').pop()
      assert.ok(target, '挑出的条目必须能取到名字')

      // 明确记成"发过了"
      await best.execute({ ...ctx, used: [target] })

      const again = await best.execute({ ...ctx, noMark: true })
      const stillThere = again.picked.some((p) => String(p.name ?? p.id).split('/').pop() === target)
      assert.equal(again.excluded >= 1, true, `应至少排除 1 张，实际 ${again.excluded}`)
      assert.equal(stillThere, false, `「${target}」刚记过却还在结果里 —— 排除没生效`)
    })
  },
)

test(
  'sticker_best：allowRepeat 时允许重复（用户明确要同一张）',
  { skip: hasStickerLibrary() ? false : '未安装 dsh-nekowhale-stickers，跳过真库用例' },
  async () => {
    await withTempHome(async () => {
      const tools = boot()
      const best = tools.get('sticker_best')
      const ctx = { context: '好累 想睡觉 哈欠', minScore: 0.2, topK: 3 }
      const a = await best.execute({ ...ctx, used: ['8N09_哈欠'] })
      assert.ok(a.picked.length > 0)
      const b = await best.execute({ ...ctx, allowRepeat: true, noMark: true })
      assert.equal(b.excluded, 0, 'allowRepeat 时必须一张都不排')
    })
  },
)
