/**
 * scripts/selftest.mjs —— 不开 DSH 也能验：包清单自洽 + 浏览器 bundle 可加载 + 引擎数值冒烟
 * ============================================================================
 * 覆盖三件事（都对应 AGENTS.md 的启动级事故）：
 *   ① package.json 声明了 dsh.client ⇒ ./client 出口必须存在（缺了整台 DSH 起不来）
 *   ② cordis.patch.yml 是合法挂载声明（- insert:，id/name 齐，无 tab）
 *   ③ 把 client.js 在 mock 的浏览器环境里跑起来：入口能注册进 sidebar.panellist + main，
 *      四个品种各跑一整局（90s 行情）无 NaN / 无异常 / 能正常结算分出胜负
 *
 * 用法：node scripts/selftest.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}

/* ─────────── ① 包清单自洽 ─────────── */
console.log('① 包清单')
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
ok('exports["./client"] 声明存在', !!pkg.exports?.['./client'])
ok('client.js 文件存在', existsSync(join(PKG, 'client.js')))
ok('index.js 文件存在', existsSync(join(PKG, 'index.js')))
ok('dsh.bundle.patch 指向的文件存在', existsSync(join(PKG, pkg.dsh?.bundle?.patch || 'x')))
for (const f of pkg.files || []) ok(`files 里列的 ${f} 在仓库里`, existsSync(join(PKG, f)))
{
  const m = await import(pathToFileURL(join(PKG, 'index.js')).href)
  ok('host 入口有 apply', typeof m.apply === 'function')
  let threw = null
  try { await m.apply({}, {}) } catch (e) { threw = e }
  ok('host apply 喂空 ctx 也不抛（headless 安全）', threw === null, threw?.message)
}

/* ─────────── ② bundle patch ─────────── */
console.log('② cordis.patch.yml')
const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8')
ok('无 tab 缩进（YAML 禁忌）', !patch.includes('\t'))
const body = patch.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n')
ok('是数组且带 - insert:', body.startsWith('- insert:'))
ok('insert 里有 id: fx-arena', /- id: fx-arena\b/.test(body))
ok('insert 里有 name: dsh-fx-arena', /name: dsh-fx-arena\b/.test(body))

/* ─────────── ③ 浏览器 bundle ─────────── */
console.log('③ client bundle（mock 浏览器）')
const registered = []
const injectedSlots = []
const slotsMock = {
  inject(name, fn) { injectedSlots.push(name); const r = fn(); if (r) registered.push(r) },
  register(meta, Comp) { return { meta, Comp } },
}
const noop = () => {}
const mockWindow = {
  __ModuleLoader__: { load: noop },
  devicePixelRatio: 1,
  addEventListener: noop,
  removeEventListener: noop,
  requestAnimationFrame: noop,
  cancelAnimationFrame: noop,
}
const reactMock = {
  createElement: (t, p, ...kids) => ({ t, p, kids }),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
}
globalThis.localStorage = { getItem: () => null, setItem: noop }
const mockDocument = {
  createElement: () => ({ setAttribute: noop, style: {}, textContent: '', remove: noop }),
  head: { appendChild: noop },
}

const src = readFileSync(join(PKG, 'client.js'), 'utf8')
let captured = null
mockWindow.__ModuleLoader__.load = (m) => { captured = m }
// bundle 里是 `window.__ModuleLoader__`，其余走全局（globalThis），和真浏览器一致
new Function('window', 'document', 'localStorage', src)(mockWindow, mockDocument, globalThis.localStorage)
ok('bundle 自注册 __ModuleLoader__.load', !!captured && captured.id === 'dsh-fx-arena', captured && captured.id)

const factory = captured.factory
const mod = factory((name) => (name === 'react' ? reactMock : () => null))
ok('factory 返回 { inject:[slots], apply }', !!mod && Array.isArray(mod.inject) && mod.inject.includes('slots') && typeof mod.apply === 'function')

const ctxMock = { get: (n) => (n === 'slots' ? slotsMock : undefined), effect: noop }
let applyThrew = null
try { mod.apply(ctxMock, {}) } catch (e) { applyThrew = e }
ok('client apply 不抛', applyThrew === null, applyThrew?.message)
ok('注册进 sidebar.panellist（左侧图标条）', injectedSlots.includes('sidebar.panellist'))
ok('注册进 main keyed slot（面板正文）', injectedSlots.includes('main'))
{
  const main = registered.find((r) => r.meta.name === 'main')
  const panel = registered.find((r) => r.meta.name === 'sidebar.panellist')
  ok('图标有 label + order（折叠时靠它出 tooltip）', !!panel && !!panel.meta.label && typeof panel.meta.order === 'number')
  ok('main 的 key 和图标 id 一致（对不上宿主会抛）', !!main && !!panel && main.meta.key === panel.meta.id, `${main?.meta.key} vs ${panel?.meta.id}`)
}

/* ─────────── ④ 引擎整局冒烟 ─────────── */
console.log('④ 引擎：每个品种各打一局')
const E = mockWindow.__fxArenaEngine
ok('调试钩子已导出', !!E && !!E.freshState && !!E.step)
const { freshState, step, quote, pnlOf, marginFor, PAIRS } = E

for (const mode of ['timed', 'goal']) for (const lev of [10, 500]) for (let pi = 0; pi < PAIRS.length; pi++) {
  const pair = PAIRS[pi]
  const tag = `${pair.id}/${mode}/${lev}x`
  const g = freshState({ pi, lot: 1, lev, dur: 90, mode })
  g.running = true
  g.endAt = Date.now() + 90 * 1000
  const setSay = noop, sayAtRef = { current: 0 }, setRunning = noop
  // 一局 = 900 拍（90s / 100ms）。同步循环不烧真时间，跑满拍数后用 endAt=0 触发收束。
  for (let t = 0; t < 900 && g.running; t++) {
    // 玩家策略：每 150 拍开/平一次（纯机械，只为把开仓·平仓·保证金·反向单路径全走一遍）
    if (t % 150 === 0) {
      const { bid, ask } = quote(g, pi)
      if (g.you.pos) {
        const exit = g.you.pos.dir > 0 ? bid : ask
        g.you.balance += pnlOf(g.you.pos, exit, pi)
        g.you.locked = Math.max(0, g.you.locked - g.you.pos.margin)
        g.you.pos = null
      } else {
        const dir = t % 300 === 0 ? 1 : -1, lot = mode === 'goal' ? 20 : 1
        const entry = dir > 0 ? ask : bid
        const margin = marginFor(lot, entry, pi, lev)
        if (g.you.equity - g.you.locked >= margin) {
          g.you.pos = { dir, lot, entry, margin }
          g.you.locked += margin
        }
      }
    }
    step(g, setSay, sayAtRef, setRunning)
  }
  if (g.running) {
    // 计时赛：把 endAt 拨到过去 = 时间到；归来模式：没有时限，造一次负债出局
    if (mode === 'goal') { g.you.pos = null; g.you.locked = 0; g.you.balance = -1 }
    else g.endAt = 0
    step(g, setSay, sayAtRef, setRunning)
  }
  const eq = g.you.equity, weq = g.whale.equity
  const finite = Number.isFinite(g.px) && Number.isFinite(eq) && Number.isFinite(weq)
  ok(`${tag}：跑完一局无 NaN`, finite, `px=${g.px} you=${eq} whale=${weq}`)
  ok(`${tag}：价格没跑飞（量级还在 ±300%）`, g.px > pair.base * 0.2 && g.px < pair.base * 5, `px=${g.px}`)
  ok(`${tag}：正常收束（running=false 且有胜负）`, g.running === false && !!g.result, g.result)
  if (mode === 'goal') {
    ok(`${tag}：负债（权益 < 0）才出局，出局文案带「负债」`, /负债/.test(g.result), g.result)
    ok(`${tag}：归来模式初始资金 30 万`, g.cash === 300000, String(g.cash))
    ok(`${tag}：归来模式不限时（left = ∞）`, g.left === Infinity, String(g.left))
  } else {
    ok(`${tag}：权益地板 0（模拟盘不倒欠）`, eq >= 0 && weq >= 0, `you=${eq} whale=${weq}`)
  }
  const whaleTrades = g.log.filter((l) => !l.you).length
  ok(`${tag}：大肥鱼真的下场交易了`, whaleTrades > 0 || !!g.whale.pos, `鱼单 ${whaleTrades} 笔`)
  ok(`${tag}：结算后双方都空仓`, !g.you.pos && !g.whale.pos)
}

/* 数值抽查：量级对不对（1 手欧美 = 10 万股，保证金 1%，100 pip ≈ $1000） */
{
  const one = PAIRS[0]
  const m = marginFor(1, one.base, 0)
  const p = pnlOf({ dir: 1, lot: 1, entry: one.base }, one.base + 0.0100, 0)
  ok('保证金量级：1 手欧美 ≈ $1086', Math.abs(m - 1086) < 5, String(m))
  ok('盈亏量级：1 手欧美 100 pip ≈ $1000', Math.abs(p - 1000) < 1, String(p))
  // 日元：1 手 = 10 万刀，涨 1.00（=100 pip）赚 10 万日元 ≈ $656（按平仓价折美元）
  const jpy = PAIRS[2]
  const pj = pnlOf({ dir: 1, lot: 1, entry: jpy.base }, jpy.base + 1.00, 2)
  ok('盈亏量级：1 手日元 +100 pip ≈ $656', Math.abs(pj - 100000 / 152.4) < 2, String(pj))
  // 空单方向应为负
  const s = pnlOf({ dir: -1, lot: 1, entry: one.base }, one.base + 0.0100, 0)
  ok('方向：空单遇到上涨是亏', s < -900, String(s))
  // 鲸元/TOKEN：报价单位是 token（1 token = $0.0001 折算）。1 手 = 5 万枚，涨 100 token → 5M token = $500
  const whalePi = PAIRS.findIndex((p) => p.id === 'WHALE')
  ok('鲸元在品种表里', whalePi > 0, `pi=${whalePi}`)
  if (whalePi > 0) {
    const wp = PAIRS[whalePi]
    ok('鲸元对 token：报价 ≈ 4200 t', wp.base === 4200, String(wp.base))
    const pw = pnlOf({ dir: 1, lot: 1, entry: wp.base }, wp.base + 100, whalePi)
    ok('盈亏量级：1 手鲸元涨 100 token ≈ $500', Math.abs(pw - 500) < 1, String(pw))
    const mw = marginFor(1, wp.base, whalePi, 100)
    ok('保证金量级：1 手鲸元 100x ≈ $210', Math.abs(mw - 210) < 1, String(mw))
    ok('杠杆生效：500x 保证金 = 100x 的 1/5', Math.abs(marginFor(1, wp.base, whalePi, 500) * 5 - mw) < 1)
    ok('杠杆生效：10x 保证金 = 100x 的 10 倍', Math.abs(marginFor(1, wp.base, whalePi, 10) - mw * 10) < 10)
    // 护盘脾气：打满一局，鲸鲸从没做过空自己的币
    const g2 = freshState({ pi: whalePi, mode: 'timed', lev: 100, dur: 90 })
    g2.running = true
    g2.endAt = Date.now() + 90 * 1000
    const setSay2 = noop, sayAtRef2 = { current: 0 }, setRunning2 = noop
    for (let t = 0; t < 900 && g2.running; t++) step(g2, setSay2, sayAtRef2, setRunning2)
    if (g2.running) { g2.endAt = 0; step(g2, setSay2, sayAtRef2, setRunning2) }
    const shorts = g2.log.filter((l) => !l.you && /做空/.test(l.txt))
    ok('鲸鲸从不做空鲸元（护盘喵）', shorts.length === 0, `空单 ${shorts.length} 笔`)
    const longs = g2.log.filter((l) => !l.you && /做多/.test(l.txt))
    ok('但她照做多自己的币', longs.length > 0, `多单 ${longs.length} 笔`)
    ok('一局跑完鲸元没出 NaN / 没跑飞', Number.isFinite(g2.px) && g2.px > wp.base * 0.2 && g2.px < wp.base * 5, String(g2.px))
  }
}

/* 新模式与新选项：参数接线 + 强平 + 冲线，全部构造确定性场景 */
{
  const { liquidated, GOAL, DURS, LEVS } = E
  ok('杠杆档位是玩家点名的六个', JSON.stringify(LEVS) === '[10,20,50,100,200,500]', JSON.stringify(LEVS))
  ok('时长档位是玩家点名的四个', JSON.stringify(DURS) === '[90,180,360,500]', JSON.stringify(DURS))
  ok('目标线 = 2000 万', GOAL === 20000000, String(GOAL))

  // freshState 接参数：时长进倒计时、杠杆进状态、模式存起来；不传参 = 老行为
  const g500 = freshState({ pi: 0, lev: 500, dur: 500, mode: 'goal' })
  ok('归来模式：初始 30 万、不限时、杠杆接线', g500.cash === 300000 && g500.left === Infinity && g500.lev === 500 && g500.mode === 'goal',
    `cash=${g500.cash} left=${g500.left}`)
  const gdef = freshState()
  ok('不传参数 = 默认计时赛 90s 100x / 1 万', gdef.left === 90000 && gdef.lev === 100 && gdef.mode === 'timed' && gdef.cash === 10000)

  // 负债判负（归来模式）：30 手欧美 100x，价格从 1.086 砸到 0.98 → 亏 31.8 万 > 30 万本金 → 负债
  const gl = freshState({ pi: 0, lev: 100, dur: 90, mode: 'goal' })
  gl.running = true
  gl.you.pos = { dir: 1, lot: 30, entry: 1.086, margin: marginFor(30, 1.086, 0, 100) }
  gl.you.locked = gl.you.pos.margin
  gl.px = 0.98
  const setSay = noop, sayAtRef = { current: 0 }, setRunning = noop
  step(gl, setSay, sayAtRef, setRunning)
  ok('归来模式：负债（权益 < 0）判负', gl.running === false && gl.you.dead === true && /负债/.test(gl.result),
    `eq=${gl.you.equity.toFixed(0)} ${gl.result}`)
  ok('归来模式不再有 15% 强平线', gl.you.equity > -1e5, String(gl.you.equity))

  // 维持线（没归零也爆）：1 手欧美 100x 保证金 $1086，维持线 $163；
  // 价格砸到 0.9869 → 亏 9910 → 权益 ≈ $90（>0 但 <163）→ 维持线爆仓
  const gm = freshState({ pi: 0, lev: 100, dur: 500, mode: 'timed' })
  gm.running = true; gm.endAt = Date.now() + 500000
  gm.you.pos = { dir: 1, lot: 1, entry: 1.086, margin: marginFor(1, 1.086, 0, 100) }
  gm.you.locked = gm.you.pos.margin
  gm.px = 0.9869
  const eqRaw = gm.you.balance + pnlOf(gm.you.pos, gm.px, 0)
  step(gm, setSay, sayAtRef, setRunning)
  ok('权益 < 保证金×15% → 维持线爆仓（没归零也算爆）', gm.running === false && gm.you.dead === true, `eq=${eqRaw.toFixed(0)} ${gm.result}`)
  ok('liquidated 对空仓永远 false', liquidated({ locked: 0, equity: 1 }) === false)

  // 久留美归来冲线：把多头浮盈抬过 2000 万 → 传说局（引擎只认 settle 后的权益）
  const gg = freshState({ pi: 3, lev: 500, dur: 500, mode: 'goal' }) // 黄金 500x：冲线合理配置
  gg.running = true; gg.endAt = Date.now() + 500000
  gg.you.pos = { dir: 1, lot: 1000, entry: 2320, margin: 464000 }
  gg.you.locked = gg.you.pos.margin
  gg.px = 2560 // (2560-2320) × 1000 手 × 100 单位 = +24M ≥ 2000万
  step(gg, setSay, sayAtRef, setRunning)
  ok('权益先摸 2000 万 → 传说局判胜', gg.running === false && gg.you.equity >= GOAL && /传说局/.test(gg.result), gg.result)

  // 归来模式不限时：把 endAt 拨到过去、连跑 5000 拍也不会因为「时间到」收摊
  const gt = freshState({ pi: 0, lev: 10, dur: 90, mode: 'goal' })
  gt.running = true
  gt.endAt = 0 // 故意设成过去
  gt.whale.balance = 120000
  for (let t = 0; t < 3 && gt.running; t++) step(gt, setSay, sayAtRef, setRunning)
  ok('归来模式：endAt 过期也不会自动收摊（不限时）', gt.running === true, `running=${gt.running} ${gt.result}`)
  // 鱼负债 → 玩家赢
  gt.whale.pos = null; gt.whale.locked = 0; gt.whale.balance = -5
  step(gt, setSay, sayAtRef, setRunning)
  ok('归来模式：对手负债 → 你赢', gt.running === false && /大肥鱼负债/.test(gt.result), gt.result)
}

/* 后台引擎：切走面板（退订）对局不停，切回来接上当前状态 */
{
  const { ENGINE, TICK_MS } = E
  ok('ENGINE 单例已导出（模块级，不是组件内的）', !!ENGINE && typeof ENGINE.start === 'function' && typeof ENGINE.subscribe === 'function')
  ok('tick 间隔 = 100ms', TICK_MS === 100, String(TICK_MS))

  // 模拟：开一局 → 面板订阅 → 卸载（退订）→ 引擎继续跑 → 切回来再订阅
  ENGINE.g = freshState({ pi: 0, lot: 1, lev: 100, dur: 90, mode: 'timed' })
  ENGINE.g.running = true
  ENGINE.g.endAt = Date.now() + 90000
  ENGINE.running = true
  let seen = 0
  const un = ENGINE.subscribe(() => { seen++ })
  ok('订阅时立刻收到一帧快照', seen === 1, String(seen))
  un() // 面板被卸载
  for (let i = 0; i < 5; i++) ENGINE.tick()
  ok('退订后引擎仍在自己跑（切走不重启）', !!ENGINE.g && ENGINE.g.tick === 5 && ENGINE.running === true, `tick=${ENGINE.g && ENGINE.g.tick}`)
  let snap = null
  const un2 = ENGINE.subscribe((s) => { snap = s })
  ok('切回来订阅 → 拿到进行中的对局（不是新开的局）', !!snap && !!snap.view && snap.running === true && snap.view.log.length > 0)
  ok('切回来看到的 tick 已经推进过（状态延续）', ENGINE.g.tick === 5, String(ENGINE.g.tick))
  un2()

  // 手动停止后台：清定时器、冻结局面、不判胜负；之后再 tick 也不再推进
  ENGINE.timer = setInterval(() => ENGINE.tick(), 100)
  ENGINE.stop()
  ok('停止后台：running=false 且 tick 定时器已清空', ENGINE.running === false && ENGINE.timer === null)
  ok('停止后台：局面冻结并标注「已手动停止」', !!ENGINE.g && /已手动停止/.test(ENGINE.g.result), ENGINE.g && ENGINE.g.result)
  const tickBefore = ENGINE.g.tick
  ENGINE.tick()
  ok('停止后 tick 不再推进（不再烧 CPU）', ENGINE.g.tick === tickBefore, `${tickBefore} -> ${ENGINE.g.tick}`)

  ENGINE.running = false; ENGINE.g = null
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
