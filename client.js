/**
 * dsh-fx-arena —— FX战士大肥鱼 · 浏览器半端（左侧图标条入口 + 实时交易面板）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本（DSH 的约定）：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * 往**左侧图标条**写入口的写法（抄宿主自带面板）：
 *   · `sidebar.panellist`：登记一条 { name, id, order, label } + 图标组件
 *     —— 这是左侧那条竖排图标，label 是折叠时的 tooltip。
 *   · `main`（root 作用域 keyed slot）：用**同一个 id** 登记面板正文。
 *     选中图标后宿主渲染的就是它。（`conversation` 是会话保留 key，别用。）
 *
 * 游戏**零联网、零真钱**：价格是本地 GBM 随机游走 + 偶发消息冲击；
 * 对手「大肥鱼 / 鲸鲸」是一个本地算法交易者，和玩家看**同一条**价格流。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-fx-arena',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /* ───────────────────────── 市场配置 ───────────────────────── */
    const TICK_MS = 100              // 价格跳动间隔
    const TPC = 20                   // 每 20 个 tick 合成一根 K 线（= 2s）
    const CANDLES = 72               // 图上最多留多少根
    const START_CASH = 10000         // 计时赛：双方开局资金
    const GOAL_CASH = 300000         // 重生之久留美归来：初始 30 万（无时限，负债判负喵）
    const LEVS = [10, 20, 50, 100, 200, 500]   // 可选杠杆（默认 100）
    const DURS = [90, 180, 360, 500]           // 可选局时（秒，默认 90；仅计时赛用）
    const GOAL = 20000000            // 重生之久留美归来：权益先到 2000 万喵
    const MAINT = 0.15               // 强平线：权益 < 占用保证金 × 15% 就爆
    const SPREAD = 1.0               // 点差（pip，双向成本）
    const TOKEN_USD = 0.0001         // 游戏内汇率：1 token = $0.0001（$100/百万 token），所有 TOKEN 对折美元记账都按这个喵
    const PAIRS = [
      // 1 EUR = 10860 token（= $1.086）。1 手 = 10 万枚；1 pip = 1 token。
      { id: 'EURTKN', label: 'EUR/TOKEN', base: 10860, vol: 0.7, dp: 0, pip: 1, sfx: ' t',
        units: 100000, baseUsd: (p) => p * TOKEN_USD, quoteUsd: () => TOKEN_USD },
      // 1 GBP = 12710 token（= $1.271）。
      { id: 'GBPTKN', label: 'GBP/TOKEN', base: 12710, vol: 0.8, dp: 0, pip: 1, sfx: ' t',
        units: 100000, baseUsd: (p) => p * TOKEN_USD, quoteUsd: () => TOKEN_USD },
      // 1 token = 0.015140 JPY。1 手 = 10 亿 token；1 pip = 0.000001 JPY。
      { id: 'TKNJPY', label: 'TOKEN/JPY', base: 0.015140, vol: 0.000001, dp: 6, pip: 0.000001,
        units: 1000000000, baseUsd: () => TOKEN_USD, quoteUsd: (p) => TOKEN_USD / p },
      { id: 'XAUUSD', label: '黄金', base: 2320.0, vol: 0.28, dp: 2, pip: 0.1,
        units: 100, baseUsd: (p) => p, quoteUsd: () => 1 },
      // 鲸元/TOKEN：鲸鲸的币兑「token」的行情。
      // 1 鲸元 ≈ 4200 token；波动是外汇的十几倍。炒她自己的币，她会当场跳脚喵。
      { id: 'WHALE', label: '鲸元/TOKEN', base: 4200, vol: 5, dp: 1, pip: 1, sfx: ' t',
        units: 50000, baseUsd: (p) => p * TOKEN_USD, quoteUsd: () => TOKEN_USD },
    ]

    /** 可复现的伪随机（mulberry32）。同一局里玩家和大肥鱼看同一条价格流。 */
    function rng(seed) {
      let a = seed >>> 0
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    const gauss = (r) => {
      let u = 0, v = 0
      while (u === 0) u = r()
      while (v === 0) v = r()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }

    const fmtMoney = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    /** 价格显示：小数位跟着品种走；鲸元/TOKEN 这类自带单位后缀（sfx） */
    const fmtPx = (v, pair) => Number(v).toFixed(pair.dp) + (pair.sfx || '')
    /** 大数缩写：$12.3M / $456K / $7.89 —— 重生之久留美归来显示 2000 万这种量级用 */
    const fmtShort = (v) => {
      const a = Math.abs(v), s = v < 0 ? '-' : ''
      if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
      if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`
      return `${s}$${a.toFixed(2)}`
    }

    /* ───────────────────────── 鲸鲸台词（人设：蓝色大肥鱼「鲸鲸」，傲娇小萝莉）───────────────────────── */
    // 傲娇小萝莉，自称「本小姐 / 鲸鲸」，叫玩家「狗修鲸」，句尾带「喵」，嘴硬心软。
    const LINES = {
      start: [
        '切磋是吧？行，本小姐勉为其难陪你玩一局喵。可别哭着回家哦，狗修鲸。',
        '哼，就你？也配和鲸鲸对盘？给你 90 秒，看谁先爆仓喵。',
        '本小姐今天心情好，让你三分手……才怪，一个 pip 都不让喵！',
        '先说好，这是模拟盘，输赢不花钱——不然你哪赔得起本小姐喵。',
      ],
      whaleOpen: [
        '看好了，本小姐要开仓了喵。',
        '这波本小姐看多，跟着我，别拖后腿喵。',
        '空！方向反了别怪我喵。',
        '嗯……有点意思，本小姐下场了喵。',
      ],
      whaleWin: [
        '哼哼，赚了吧？跟着鲸鲸有肉吃喵～',
        '本小姐的盘感，是天赋喵。羡慕吧？',
        '这才哪到哪，狗修鲸你盯紧点喵。',
      ],
      whaleLose: [
        '嘁，浮亏而已，本小姐在憋大招喵……',
        '才、才不是看错方向了！是市场在洗盘喵！',
        '别笑！再笑本小姐就把仓位加倍给你看喵。',
      ],
      playerWin: [
        '……行吧，这局算你走运喵。再来一局，本小姐绝对翻盘！',
        '哼，让你赢一次尾巴都要翘上天了喵？下局见真章。',
        '狗修鲸……居然赢了本小姐。记住了，此仇必报喵！',
      ],
      playerLose: [
        '看到没？这就是和鲸鲸的差距喵～要不要拜师？学费很贵的哦。',
        '啧，爆仓都做不到，狗修鲸你练练再来喵。',
        '本小姐赢了～今晚加餐，吃白饭庆祝喵！',
      ],
      draw: ['平局？无趣喵。再来。'],
      hint: [
        '提示：点差是要成本的，别手痒乱开喵。',
        '提示：杠杆 100 倍，仓位大一点，但别把自己挤爆喵。',
        '提示：金（XAU）波动大，鲸元/TOKEN 更野，胆小就做欧美喵。',
      ],
      // 炒到鲸鲸自己的币了喵……（做空=她护盘破防，做多=她嘴硬地认可你）
      whaleCoinShort: [
        '你、你做空本小姐的币？！鲸元哪里不值 4200 token 了喵！',
        '做空鲸元是吧……行，本小姐记住这张脸了喵。',
        '不许说本小姐的币是空气币！那是……那是价值待发现喵！',
        '哼，空单爆仓的人每年都有好多，头一个就是你喵！',
      ],
      whaleCoinLong: [
        '哦？做多鲸元，有眼光喵……才、才不是我夸你呢。',
        '算你识货。本小姐的币当然要本小姐自己拉喵。',
        '买鲸元？行吧，这单本小姐罩着你，别乱平喵。',
      ],
      // 重生之久留美归来（2000 万）专属收尾
      goalWin: [
        '2、2000 万喵？！你肯定开挂了吧！本小姐要求重赛喵！',
        '……行，这次算你运气加胆子都不要脸。下局本小姐认真了喵。',
      ],
      goalLose: [
        '看到了喵？这就叫鲸鲸速度。2000 万，跟玩一样。',
        '本小姐到 2000 万了喵！狗修鲸你在家慢慢数零吧～',
      ],
    }
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

    /* ───────────────────────── 样式 ───────────────────────── */
    const CSS = `
[data-fxa]{--fxa-up:#22c55e;--fxa-dn:#ef4444;--fxa-whale:#38bdf8;--fxa-you:#a78bfa;
  display:flex;flex-direction:column;gap:12px;padding:4px 4px 10px;color:inherit;
  font-variant-numeric:tabular-nums;}
[data-fxa-head]{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
[data-fxa-title]{font-size:16px;font-weight:700;letter-spacing:.02em;}
[data-fxa-sub]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fxa-clock]{margin-left:auto;display:flex;align-items:center;gap:8px;}
[data-fxa-timer]{font-size:22px;font-weight:800;min-width:64px;text-align:center;
  padding:2px 10px;border-radius:8px;background:rgba(127,127,127,.12);}
[data-fxa-pairs]{display:flex;gap:6px;flex-wrap:wrap;}
[data-fxa-setup]{display:flex;flex-direction:column;gap:6px;}
[data-fxa-row]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
[data-fxa-tag]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);margin-left:6px;}
[data-fxa-chip]{height:24px;padding:0 10px;border-radius:999px;font-size:11px;cursor:pointer;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:transparent;}
[data-fxa-chip][data-on]{background:var(--dsw-alias-accent,#3b82f6);color:#fff;border-color:transparent;font-weight:700;}
[data-fxa-chip]:disabled{opacity:.5;cursor:default;}
[data-fxa-goals]{display:flex;flex-direction:column;gap:4px;}
[data-fxa-goal]{display:flex;align-items:center;gap:8px;font-size:12px;}
[data-fxa-bar]{flex:1;height:8px;border-radius:4px;background:rgba(127,127,127,.18);overflow:hidden;}
[data-fxa-fill]{height:100%;border-radius:4px;transition:width .2s;}
[data-fxa-fill][data-whale]{background:var(--fxa-whale);}
[data-fxa-fill][data-you]{background:var(--fxa-you);}
[data-fxa-goalnum]{min-width:72px;text-align:right;font-weight:700;}
[data-fxa-goaltarget]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fxa-flyer]{font-size:14px;font-weight:800;padding:1px 10px;border-radius:999px;
  background:rgba(56,189,248,.16);color:var(--fxa-whale);}
[data-fxa-pair]{height:30px;padding:0 12px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));
  background:transparent;color:inherit;}
[data-fxa-pair][data-on]{background:var(--dsw-alias-accent,#3b82f6);color:#fff;border-color:transparent;}
[data-fxa-chartwrap]{position:relative;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.28));
  border-radius:10px;overflow:hidden;background:rgba(0,0,0,.14);}
[data-fxa-chart]{display:block;width:100%;height:280px;}
[data-fxa-badge]{position:absolute;top:8px;font-size:11px;padding:2px 8px;border-radius:999px;
  background:rgba(0,0,0,.42);color:#fff;pointer-events:none;}
[data-fxa-scores]{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
[data-fxa-card]{border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.28));border-radius:10px;
  padding:10px 12px;display:flex;flex-direction:column;gap:4px;}
[data-fxa-card][data-w]{border-top:3px solid var(--fxa-whale);}
[data-fxa-card][data-y]{border-top:3px solid var(--fxa-you);}
[data-fxa-who]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);display:flex;gap:6px;align-items:center;}
[data-fxa-eq]{font-size:22px;font-weight:800;}
[data-fxa-pos]{font-size:11px;line-height:17px;white-space:pre-line;color:var(--dsw-alias-label-secondary,#b8bcc2);}
[data-fxa-ctrl]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-fxa-lot]{display:flex;align-items:center;gap:6px;font-size:12px;}
[data-fxa-lot input]{width:70px;height:30px;padding:0 8px;font-size:12px;border-radius:7px;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));background:transparent;}
[data-fxa-btn]{height:32px;padding:0 16px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;color:#fff;border:0;}
[data-fxa-btn][data-buy]{background:var(--fxa-up);}
[data-fxa-btn][data-sell]{background:var(--fxa-dn);}
[data-fxa-btn][data-close]{background:transparent;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.4));font-weight:600;}
[data-fxa-btn][data-go]{background:var(--dsw-alias-accent,#3b82f6);}
[data-fxa-btn]:disabled{opacity:.45;cursor:default;}
[data-fxa-whaleline]{display:flex;align-items:flex-start;gap:8px;}
[data-fxa-avatar]{flex:none;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:rgba(56,189,248,.18);font-size:16px;}
[data-fxa-say]{font-size:12.5px;line-height:19px;padding:8px 12px;border-radius:10px;background:rgba(127,127,127,.10);}
[data-fxa-log]{font-size:11px;line-height:17px;max-height:92px;overflow:auto;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fxa-log] [data-buy]{color:var(--fxa-up);}
[data-fxa-log] [data-sell]{color:var(--fxa-dn);}
[data-fxa-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fxa-result]{font-size:13px;font-weight:700;padding:8px 12px;border-radius:8px;background:rgba(127,127,127,.12);}
`

    /** 一局时长 → 毫秒。重生之久留美归来同样用玩家选的时长当上限（10s 冲 2000 万是硬核局，500s 是休闲局） */
    const roundMs = (durSec) => (durSec || 90) * 1000

    /** 空中飞人次数：归来模式每负债出局一次 +1，跨局持久（localStorage 不可用时退内存） */
    const FLYER_KEY = 'fx-arena-flyer'
    let flyerMem = 0
    function readFlyer() {
      try {
        const n = Number(localStorage.getItem(FLYER_KEY))
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
      } catch { return flyerMem }
    }
    function writeFlyer(n) {
      flyerMem = n
      try { localStorage.setItem(FLYER_KEY, String(n)) } catch { /* 忽略 */ }
      return n
    }

    /* ─────────────────── 后台对局引擎（模块级单例） ───────────────────
     * DSH 在切到会话 / 切到别的面板时会卸载这块面板，组件里的定时器跟着没了。
     * 所以对局状态 + tick 循环放在**模块作用域**：面板只是订阅者，
     * 卸载只退订、不停表；切回来直接接上当前快照，不重开一局喵。
     */
    const ENGINE = {
      g: null,
      cfg: null,
      timer: null,
      running: false,
      say: '',
      sayRef: { current: 0 },
      subs: new Set(),
      /** 空中飞人次数：归来模式里每输一局 +1（跨局持久，存在 localStorage） */
      flyer: readFlyer(),

      viewOf(g) {
        return {
          last: g.px, pi: g.pi, left: g.left, result: g.result, log: g.log,
          you: { ...g.you }, whale: { ...g.whale, pos: g.whale.pos ? { ...g.whale.pos } : null },
        }
      },
      snap() {
        return { view: this.g ? this.viewOf(this.g) : null, say: this.say, running: this.running, flyer: this.flyer }
      },
      subscribe(fn) {
        this.subs.add(fn)
        try { fn(this.snap()) } catch { /* 忽略 */ }
        return () => this.subs.delete(fn)
      },
      emit() {
        const s = this.snap()
        for (const fn of this.subs) { try { fn(s) } catch { /* 单个面板出错不影响引擎 */ } }
      },
      setSay(line) {
        this.say = line
        this.emit()
      },
      setRunning(v) {
        this.running = v
        if (!v) { clearInterval(this.timer); this.timer = null }
        this.emit()
      },
      /** 开一局（运行中调用 = 重开一局） */
      start(c) {
        const g = freshState(c)
        g.running = true
        g.endAt = c.mode === 'goal' ? Infinity : Date.now() + roundMs(c.dur)
        this.g = g
        this.cfg = { ...c }
        this.running = true
        this.say = ''
        this.sayRef.current = 0
        clearInterval(this.timer)
        this.timer = setInterval(() => this.tick(), TICK_MS)
        this.emit()
        speak(pick(c.mode === 'goal'
          ? ['「重生之久留美归来」？哼，本小姐上辈子就爆过你的仓，这辈子记得一清二楚喵。', '这次没有倒计时了喵——负债才算出局，你悠着点。', '30 万本金，2000 万目标，没时限。谁先负债谁先抬走喵。']
          : LINES.start), (l) => this.setSay(l), this.sayRef)
      },
      tick() {
        const g = this.g
        if (!g || !this.running) return
        step(g, (l) => this.setSay(l), this.sayRef, (v) => this.setRunning(v))
        this.emit()
      },
      /** 手动停止后台：清掉 tick 定时器、冻结当前局面（不判输赢、不记录战绩）喵 */
      stop() {
        clearInterval(this.timer)
        this.timer = null
        this.running = false
        if (this.g) {
          this.g.running = false
          if (!this.g.result) this.g.result = '⏸ 已手动停止后台运行（局面冻结，按「开始切磋」重开一局）'
        }
        this.say = '……行吧，本小姐先歇会儿喵。后台循环停了，省点电。'
        this.emit()
      },
      trade(dir, c) {
        const g = this.g
        if (!g || !g.running) return
        g.lastActionAt = Date.now()
        if (g.you.pos && g.you.pos.dir === dir) {
          this.setSay('已经持有这个方向了喵，先平再开。')
          return
        }
        const maxLot = g.mode === 'goal' ? 50 : 10 // 归来模式允许更重的手数去复利冲线
        const lot = Math.min(maxLot, Math.max(0.1, Number(c.lot) || 1))
        const { bid, ask } = quote(g, c.pi)
        const entry = dir > 0 ? ask : bid
        const margin = marginFor(lot, entry, c.pi, g.lev)
        if (g.you.equity - g.you.locked < margin) {
          this.setSay('保证金不够了喵！先平点仓位，或者把手数调小喵。')
          return
        }
        // 已有反向仓：先平（盈亏当场结算）
        if (g.you.pos) closeYou(g, c.pi, (l) => this.setSay(l), this.sayRef)
        g.you.locked += margin
        // 点差成本天然含在 bid/ask 里（开多用 ask、平多用 bid），不另扣
        g.you.pos = { dir, lot, entry, margin }
        g.log.unshift({ t: Date.now(), dir, txt: `${dir > 0 ? '买' : '卖'} ${lot} 手 @ ${fmtPx(entry, PAIRS[c.pi])}`, you: true })
        // 炒到本小姐自己的币了？反应当然不一样喵。
        const coin = PAIRS[c.pi].id === 'WHALE'
        this.setSay(pick(coin ? (dir > 0 ? LINES.whaleCoinLong : LINES.whaleCoinShort) : [
          dir > 0 ? '做多？行，本小姐看着你喵。' : '做空？有点胆子嘛，狗修鲸喵。',
          dir > 0 ? '又是多单……你就不怕接飞刀喵？' : '空单是吧，本小姐记下了喵。',
        ]))
        this.emit()
      },
      close(c) {
        const g = this.g
        if (!g || !g.running || !g.you.pos) return
        closeYou(g, c.pi, (l) => this.setSay(l), this.sayRef)
        this.setSay(pick(['平仓了？手还挺快喵。', '落袋为安，也算你会玩喵。', '嗯，平了。别问本小姐赚没赚喵。']))
        this.emit()
      },
    }

    /* ───────────────────────── 主面板 ───────────────────────── */
    function Arena() {
      const [cfg, setCfg] = useState(() => (ENGINE.cfg ? { ...ENGINE.cfg } : { pi: 0, lot: 1, lev: 100, dur: 90, mode: 'timed' }))
      const cfgRef = useRef(cfg)
      cfgRef.current = cfg // 交易参数每拍现读，不受闭包过期影响
      const [view, setView] = useState(() => (ENGINE.g ? ENGINE.viewOf(ENGINE.g) : freshState(cfg)))
      const [say, setSay] = useState(ENGINE.say)
      const [running, setRunning] = useState(ENGINE.running)
      const [flyer, setFlyer] = useState(ENGINE.flyer)
      const canvasRef = useRef(null)

      /** 订阅后台引擎：卸载时只退订，对局照常跑喵 */
      useEffect(() => ENGINE.subscribe(({ view, say, running, flyer }) => {
        if (view) setView(view)
        setSay(say)
        setRunning(running)
        if (typeof flyer === 'number') setFlyer(flyer)
      }), [])

      /** 开一局（运行中调用 = 重开一局） */
      const start = useCallback(() => ENGINE.start(cfgRef.current), [])

      /** 绘制循环 */
      useEffect(() => {
        let raf = 0
        let idle = null
        const draw = () => {
          const cv = canvasRef.current
          const g = ENGINE.g
          if (cv) {
            if (!g) {
              if (!idle) idle = freshState(cfgRef.current)
              drawChart(cv, idle, cfgRef.current.pi)
            } else drawChart(cv, g, g.pi)
          }
          raf = requestAnimationFrame(draw)
        }
        raf = requestAnimationFrame(draw)
        return () => cancelAnimationFrame(raf)
      }, [cfg.pi])

      const pair = PAIRS[cfg.pi]
      const you = view.you, whale = view.whale
      const px = view.last
      const busy = running

      const trade = (dir) => ENGINE.trade(dir, cfgRef.current)
      const close = () => ENGINE.close(cfgRef.current)

      // 重生之久留美归来进度：对数刻度（10K→20M 跨三个数量级，线性条会全程趴窝）
      // 归来模式进度：对数刻度（30 万→2000 万）；负债时进度归零喵
      const goalPct = (eq) => {
        const lo = Math.log10(GOAL_CASH), hi = Math.log10(GOAL)
        return Math.max(0, Math.min(100, (Math.log10(Math.max(GOAL_CASH, eq)) - lo) / (hi - lo) * 100))
      }

      return h('div', { 'data-fxa': '' },
        // ── 标题 + 计时 ──
        h('div', { 'data-fxa-head': '' },
          h('div', null,
            h('div', { 'data-fxa-title': '' }, 'FX战士大肥鱼'),
            h('div', { 'data-fxa-sub': '' }, running ? '后台运行中 · 切到会话也不停 · 可随时手动停止' : '本地模拟行情 · 零联网 · 零真钱 · 对手是算法版鲸鲸')),
          h('div', { 'data-fxa-clock': '' },
            h('div', { 'data-fxa-timer': '' }, fmtClock(view.left)),
            h('button', { 'data-fxa-btn': '', 'data-close': '', disabled: !running, onClick: () => ENGINE.stop() }, '停止后台'),
            h('button', { 'data-fxa-btn': '', 'data-go': '', onClick: start }, running ? '重开一局' : '开始切磋'))),

        // ── 赛制：模式 / 杠杆 / 时长 ──
        h('div', { 'data-fxa-setup': '' },
          h('div', { 'data-fxa-row': '' },
            h('span', { 'data-fxa-tag': '' }, '模式'),
            h('button', { 'data-fxa-chip': '', 'data-on': cfg.mode === 'timed' ? '' : undefined, disabled: busy,
              onClick: () => setCfg((c) => ({ ...c, mode: 'timed' })) }, '计时赛'),
            h('button', { 'data-fxa-chip': '', 'data-on': cfg.mode === 'goal' ? '' : undefined, disabled: busy,
              onClick: () => setCfg((c) => ({ ...c, mode: 'goal', lot: Math.max(c.lot, 1) })) }, '重生之久留美归来 🏔'),
            h('span', { 'data-fxa-tag': '' }, '杠杆'),
            LEVS.map((L) => h('button', {
              key: L, 'data-fxa-chip': '', 'data-on': cfg.lev === L ? '' : undefined, disabled: busy,
              onClick: () => setCfg((c) => ({ ...c, lev: L })),
            }, `${L}x`)),
            h('span', { 'data-fxa-tag': '' }, '时长'),
            cfg.mode === 'goal'
              ? h('span', { 'data-fxa-tag': '' }, '不限时')
              : DURS.map((d) => h('button', {
                key: d, 'data-fxa-chip': '', 'data-on': cfg.dur === d ? '' : undefined, disabled: busy,
                onClick: () => setCfg((c) => ({ ...c, dur: d })),
              }, `${d}s`))),
          cfg.mode === 'goal' ? h('div', { 'data-fxa-note': '' },
            `重生之久留美归来：初始资金 ${fmtShort(GOAL_CASH)}（30 万），谁的权益先摸到 ${fmtShort(GOAL)}（2000 万）谁赢。`,
            `不限时、没有强平线——只有负债（权益 < 0）才算出局。慢慢打，或者慢慢死喵。`) : null,
          cfg.mode === 'goal' ? h('div', { 'data-fxa-row': '' },
            h('span', { 'data-fxa-tag': '' }, '空中飞人'),
            h('span', { 'data-fxa-flyer': '' }, `${flyer} 次`),
            h('span', { 'data-fxa-note': '' }, '归来模式里每负债出局一次，就 +1 喵')) : null,
          cfg.mode === 'goal' && running ? h('div', { 'data-fxa-goals': '' },
            h('div', { 'data-fxa-goal': '' },
              h('span', null, '🐠'), h('div', { 'data-fxa-bar': '' },
                h('div', { 'data-fxa-fill': '', 'data-whale': '', style: { width: goalPct(whale.equity) + '%' } })),
              h('span', { 'data-fxa-goalnum': '' }, fmtShort(whale.equity))),
            h('div', { 'data-fxa-goal': '' },
              h('span', null, '🙂'), h('div', { 'data-fxa-bar': '' },
                h('div', { 'data-fxa-fill': '', 'data-you': '', style: { width: goalPct(you.equity) + '%' } })),
              h('span', { 'data-fxa-goalnum': '' }, fmtShort(you.equity))),
            h('span', { 'data-fxa-goaltarget': '' }, `→ ${fmtShort(GOAL)}`)) : null),

        // ── 品种 ──
        h('div', { 'data-fxa-pairs': '' }, PAIRS.map((p, i) =>
          h('button', {
            key: p.id, 'data-fxa-pair': '', 'data-on': i === cfg.pi ? '' : undefined,
            disabled: busy, onClick: () => {
              const next = { ...cfgRef.current, pi: i }
              setCfg(next)
              // 运行中按钮是 disabled 的；没在跑时换品种 = 丢掉上一局的结果，展示新品种的静态图
              if (!ENGINE.running) { ENGINE.g = null; ENGINE.emit(); setView(freshState(next)) }
            },
          }, p.label))),

        // ── K 线图 ──
        h('div', { 'data-fxa-chartwrap': '' },
          h('canvas', { 'data-fxa-chart': '', ref: canvasRef }),
          h('div', { 'data-fxa-badge': '', style: { left: '8px' } }, `${pair.label}  ${fmtPx(px, pair)}`),
          whale.pos ? h('div', { 'data-fxa-badge': '', style: { right: '8px' },
            'data-sell': whale.pos.dir < 0 ? '' : undefined, 'data-buy': whale.pos.dir > 0 ? '' : undefined },
            `大肥鱼 ${whale.pos.dir > 0 ? '多' : '空'} ${whale.pos.lot} 手`) : null),

        // ── 双方记分 ──
        h('div', { 'data-fxa-scores': '' },
          h('div', { 'data-fxa-card': '', 'data-w': '' },
            h('div', { 'data-fxa-who': '' }, '🐠 大肥鱼（鲸鲸）'),
            h('div', { 'data-fxa-eq': '' }, fmtMoney(whale.equity)),
            h('div', { 'data-fxa-pos': '' }, posText(whale, pair, view))),
          h('div', { 'data-fxa-card': '', 'data-y': '' },
            h('div', { 'data-fxa-who': '' }, '🙂 你'),
            h('div', { 'data-fxa-eq': '' }, fmtMoney(you.equity)),
            h('div', { 'data-fxa-pos': '' }, posText(you, pair, view)))),

        // ── 操作 ──
        h('div', { 'data-fxa-ctrl': '' },
          h('label', { 'data-fxa-lot': '' }, '手数',
            h('input', {
              type: 'number', min: '0.1', max: String(cfg.mode === 'goal' ? 50 : 10), step: '0.1', value: String(cfg.lot),
              onChange: (e) => setCfg((c) => ({ ...c, lot: Number(e.target.value) })),
            })),
          h('button', { 'data-fxa-btn': '', 'data-sell': '', disabled: !busy, onClick: () => trade(-1) }, '做空 / SELL'),
          h('button', { 'data-fxa-btn': '', 'data-buy': '', disabled: !busy, onClick: () => trade(1) }, '做多 / BUY'),
          h('button', { 'data-fxa-btn': '', 'data-close': '', disabled: !busy || !you.pos, onClick: close }, '平仓')),

        // ── 鲸鲸台词 ──
        h('div', { 'data-fxa-whaleline': '' },
          h('div', { 'data-fxa-avatar': '' }, '🐠'),
          h('div', { 'data-fxa-say': '' }, say || '……（鲸鲸在等开盘喵）')),

        // ── 战报 ──
        h('div', { 'data-fxa-log': '' }, view.log.slice(0, 14).map((e, i) =>
          h('div', { key: i },
            h('span', { [e.dir > 0 ? 'data-buy' : 'data-sell']: '' }, e.you ? '你' : '鱼'),
            '  ' + e.txt))),

        view.result ? h('div', { 'data-fxa-result': '' }, view.result) : null,
        h('div', { 'data-fxa-note': '' },
          '模拟盘，价格由本地随机游走生成，和真实外汇无关，也不涉及任何真实资金。',
          '运行中点「停止后台」会清掉行情循环、冻结局面（省 CPU）；再点「开始切磋」重开一局。'),
      )
    }

    /* ───────────────────────── 游戏引擎 ───────────────────────── */
    /** cfg = { pi, lot, lev, dur, mode }；mode: 'timed' 计时赛 / 'goal' 目标赛 */
    function freshState(cfg) {
      const c = { pi: 0, lot: 1, lev: 100, dur: 90, mode: 'timed', ...(cfg || {}) }
      const seed = (Date.now() ^ (c.pi * 7919)) >>> 0
      const r = rng(seed)
      const pair = PAIRS[c.pi]
      const candles = []
      let px = pair.base
      for (let i = 0; i < CANDLES; i++) {
        const o = px
        let hi = o, lo = o
        for (let k = 0; k < TPC; k++) { px = drift(px, pair, r); hi = Math.max(hi, px); lo = Math.min(lo, px) }
        candles.push({ o, h: hi, l: lo, c: px })
      }
      const cash = c.mode === 'goal' ? GOAL_CASH : START_CASH
      return {
        pi: c.pi, lev: c.lev, mode: c.mode, dur: c.dur, cash,
        r, px, candles, tick: 0, spikeDir: 1, spikeLeft: 0,
        last: px, lastActionAt: Date.now(), lastNudgeAt: 0,
        you: freshAccount(cash), whale: freshAccount(cash),
        whaleNextThink: 12,
        // 每局一个脾气；但炒她自己的币（鲸元）时，本小姐永远做多喵
        whaleBias: (PAIRS[c.pi].id === 'WHALE') ? 1 : (r() > 0.45 ? 1 : -1),
        running: false, endAt: 0,
        left: c.mode === 'goal' ? Infinity : roundMs(c.dur), // 归来模式不限时
        result: '',
        log: [{ t: Date.now(), dir: 1, txt: `—— 新的一局 · ${c.mode === 'goal' ? '重生之久留美归来 ' + fmtShort(GOAL) : '计时 ' + c.dur + 's'} · ${c.lev}x ——`, you: true }],
      }
    }
    const freshAccount = (cash = START_CASH) => ({ balance: cash, locked: 0, pos: null, equity: cash, peak: cash, tauntAt: 0, dead: false })

    /** GBM 一步（对数正态，波动率按品种） */
    function drift(px, pair, r) {
      const ret = pair.vol / px
      return px * Math.exp(-0.5 * ret * ret + ret * gauss(r))
    }
    /** 消息冲击：约 20~27 pip 量级（按品种 vol），偶尔来一发，给对局制造剧情 */
    function maybeShock(g) {
      const pr = PAIRS[g.pi]
      if (g.spikeLeft > 0) { g.spikeLeft--; g.px *= 1 + g.spikeDir * 3 * pr.vol / g.px; return }
      if (g.r() < 0.006) { g.spikeDir = g.r() > 0.5 ? 1 : -1; g.spikeLeft = 3 + Math.floor(g.r() * 6) }
    }
    /** 占用保证金 = 名义本金(USD) / 杠杆（g.lev 由开一局时选定） */
    const marginFor = (lot, price, pi, lev) => {
      const pr = PAIRS[pi]
      return lot * pr.units * pr.baseUsd(price) / (lev || 100)
    }
    /** 强平判定：权益跌破占用保证金的 15%（margin 为 0 时无仓，不爆） */
    const liquidated = (a) => a.locked > 0 && a.equity < a.locked * MAINT
    const priceOf = (g) => (typeof g.px === 'number' ? g.px : g.last) // live 引擎用 px，推给 React 的 view 用 last
    function quote(g, pi) {
      const spread = SPREAD * PAIRS[pi].pip
      const p = priceOf(g)
      return { bid: p - spread / 2, ask: p + spread / 2 }
    }
    /** 浮动盈亏（USD）。进出都走 quote() 的 bid/ask，点差成本天然含在里面，不再另扣。 */
    function pnlOf(pos, exit, pi) {
      if (!pos) return 0
      const pr = PAIRS[pi]
      return (exit - pos.entry) * pos.dir * pos.lot * pr.units * pr.quoteUsd(exit)
    }
    function settle(a, g, pi) {
      const { bid, ask } = quote(g, pi)
      const mark = a.pos ? (a.pos.dir > 0 ? bid : ask) : 0
      a.equity = a.balance + (a.pos ? pnlOf(a.pos, mark, pi) : 0)
      a.peak = Math.max(a.peak, a.equity)
      return a.equity
    }
    function closeYou(g, pi, setSay, sayAtRef) {
      const a = g.you
      if (!a.pos) return
      const { bid, ask } = quote(g, pi)
      const exit = a.pos.dir > 0 ? bid : ask
      const pnl = pnlOf(a.pos, exit, pi)
      a.balance += pnl; a.locked = Math.max(0, a.locked - (a.pos.margin || 0)); a.pos = null
      g.log.unshift({ t: Date.now(), dir: pnl >= 0 ? 1 : -1, txt: `平仓 ${pnl >= 0 ? '盈利' : '亏损'} ${fmtMoney(pnl)}`, you: true })
      if (a.equity < 0) speak('爆、爆仓了？！狗修鲸你……啧，本小姐都替你臊得慌喵。', setSay, sayAtRef)
    }

    function speak(line, setSay, sayAtRef) {
      const now = Date.now()
      if (now - sayAtRef.current < 1400) return // 别刷屏
      sayAtRef.current = now
      setSay(line)
    }

    /** 大肥鱼：快慢 EMA 交叉 + 每局一个方向偏好 + 30% 犹豫不跟单 */
    function whaleThink(g, setSay, sayAtRef) {
      const closes = g.candles.slice(-40).map((c) => c.c)
      if (closes.length < 25) return
      const ema = (n) => { const k = 2 / (n + 1); let e = closes[0]; for (const c of closes) e = c * k + e * (1 - k); return e }
      const fast = ema(9), slow = ema(26)
      const sig = (fast > slow ? 1 : -1) * g.whaleBias // 鱼这局想持的方向（trend / fade）
      const a = g.whale
      // 鲸元例外：本小姐的币只许涨不许跌喵（护盘）
      const dir = PAIRS[g.pi].id === 'WHALE' ? 1 : sig
      const { bid, ask } = quote(g, g.pi)
      if (a.pos && a.pos.dir !== dir) {
        const exit = a.pos.dir > 0 ? bid : ask
        const pnl = pnlOf(a.pos, exit, g.pi)
        a.balance += pnl; a.locked = Math.max(0, a.locked - (a.pos.margin || 0)); a.pos = null
        g.log.unshift({ t: Date.now(), dir: pnl >= 0 ? 1 : -1, txt: `大肥鱼平仓 ${fmtMoney(pnl)}`, you: false })
        return
      }
      if (!a.pos && g.r() > 0.3) {
        // 手数：重生之久留美归来她敢赌（拿一半可用保证金复利冲 2000 万喵）；计时模式随缘小仓
        // 粒度 0.1 手 —— 10x 低杠杆下贵品种（黄金 1 手保证金 $2.3 万）也开得起，不然她会整局装死喵
        const entry = dir > 0 ? ask : bid
        const per = marginFor(1, entry, g.pi, g.lev)
        const free = Math.max(0, a.equity - a.locked)
        if (!(per > 0) || free < per * 0.1) return // 鱼也穷，连 0.1 手都开不起喵
        const cap = g.mode === 'goal' ? 50 : 4
        const want = g.mode === 'goal'
          ? Math.floor(free / 2 / per / 0.1) * 0.1   // 复利：押一半可用保证金
          : 0.5 + Math.floor(g.r() * cap) * 0.5      // 平时：0.5 ~ 2.0 手
        const maxAfford = Math.floor(free / per / 0.1) * 0.1
        const lot = Math.max(0.1, Math.round(Math.min(cap, want, maxAfford) * 10) / 10)
        const margin = marginFor(lot, entry, g.pi, g.lev)
        a.pos = { dir, lot, entry, margin }
        a.locked += margin
        g.log.unshift({ t: Date.now(), dir, txt: `大肥鱼${dir > 0 ? '做多' : '做空'} ${lot} 手`, you: false })
        if (g.r() > 0.35) speak(pick(PAIRS[g.pi].id === 'WHALE' ? ['鲸元要涨喵！本小姐亲自下场抬轿子！', '自己的币自己拉，这很合理喵。'] : LINES.whaleOpen), setSay, sayAtRef)
      }
    }

    function step(g, setSay, sayAtRef, setRunning) {
      if (!g.running) return // finish() 之后、React 停掉定时器之前可能还有一拍，别让结算跑两遍
      g.tick++
      maybeShock(g)
      g.px = drift(g.px, PAIRS[g.pi], g.r)
      g.last = g.px
      if (g.tick % TPC === 0) {
        const c = g.candles[g.candles.length - 1]
        g.candles.push({ o: c.c, h: Math.max(c.c, g.px), l: Math.min(c.c, g.px), c: g.px })
        if (g.candles.length > CANDLES + 40) g.candles.shift()
      }
      const last = g.candles[g.candles.length - 1]
      last.h = Math.max(last.h, g.px); last.l = Math.min(last.l, g.px); last.c = g.px
      settle(g.you, g, g.pi); settle(g.whale, g, g.pi)

      if (g.tick >= g.whaleNextThink) {
        whaleThink(g, setSay, sayAtRef)
        g.whaleNextThink = g.tick + 6 + Math.floor(g.r() * 10)
      }
      // 大肥鱼赢/亏的实时嘴炮
      if (g.whale.pos) {
        const { bid, ask } = quote(g, g.pi)
        const u = pnlOf(g.whale.pos, g.whale.pos.dir > 0 ? bid : ask, g.pi)
        const now = Date.now()
        if (u > 120 && now - g.whale.tauntAt > 9000) { g.whale.tauntAt = now; speak(pick(LINES.whaleWin), setSay, sayAtRef) }
        else if (u < -120 && now - g.whale.tauntAt > 9000) { g.whale.tauntAt = now; speak(pick(LINES.whaleLose), setSay, sayAtRef) }
      }
      // 玩家 25 秒没动静，鲸鲸主动提醒一句（顺便催战）
      const now0 = Date.now()
      if (now0 - g.lastActionAt > 25000 && now0 - g.lastNudgeAt > 30000) {
        g.lastNudgeAt = now0
        speak(pick(LINES.hint), setSay, sayAtRef)
      }
      // 终局判定
      if (g.mode === 'goal') {
        // 重生之久留美归来：不限时。先摸到 2000 万 = 赢；负债（权益 < 0）= 输，没有强平线喵
        if (g.you.equity >= GOAL || g.whale.equity >= GOAL) return finish(g, setSay, setRunning)
        const youDebt = g.you.equity < 0
        const whDebt = g.whale.equity < 0
        if (youDebt || whDebt) {
          g.you.dead = youDebt; g.whale.dead = whDebt
          if (youDebt) g.log.unshift({ t: Date.now(), dir: -1, txt: '负债！你的权益跌破 0，出局喵', you: true })
          if (whDebt) g.log.unshift({ t: Date.now(), dir: -1, txt: '负债！大肥鱼的权益跌破 0 了', you: false })
          return finish(g, setSay, setRunning)
        }
        return // 没有时限，接着打喵
      }
      // 计时赛：爆仓 / 跌破维持线 / 到点收摊
      const youDead = liquidated(g.you) || g.you.equity <= 0
      const whDead = liquidated(g.whale) || g.whale.equity <= 0
      if (youDead || whDead) {
        g.you.dead = youDead; g.whale.dead = whDead
        if (youDead) g.log.unshift({ t: Date.now(), dir: -1, txt: '强平！你的仓位爆了喵', you: true })
        if (whDead) g.log.unshift({ t: Date.now(), dir: -1, txt: '强平！大肥鱼的仓位爆了', you: false })
        return finish(g, setSay, setRunning)
      }
      g.left = Math.max(0, g.endAt - Date.now())
      if (g.left <= 0) finish(g, setSay, setRunning) // 计时赛到点：比权益
    }

    function finish(g, setSay, setRunning) {
      g.running = false
      const preYou = g.you.equity, preWh = g.whale.equity // 判定看结算**前**的权益
      // 结算双方持仓。计时赛保本，模拟盘不倒欠；归来模式允许负债——负债就是出局条件喵
      for (const a of [g.you, g.whale]) {
        if (a.pos) { const { bid, ask } = quote(g, g.pi); a.balance += pnlOf(a.pos, a.pos.dir > 0 ? bid : ask, g.pi); a.pos = null }
        a.equity = g.mode === 'goal' ? a.balance : Math.max(0, a.balance)
      }
      const you = g.you.equity, wh = g.whale.equity
      let result, line
      if (g.mode === 'goal') {
        const youReach = preYou >= GOAL, whReach = preWh >= GOAL
        const youDead = g.you.dead, whDead = g.whale.dead
        if (youDead && whDead) { result = '💀💀 双双负债，神仙打架同归于尽……算平局喵'; line = pick(LINES.draw) }
        else if (youDead) { result = `💀 负债出局：你欠了 ${fmtMoney(-you)}，大肥鱼 ${fmtShort(wh)} 在旁边吃白饭看你熄火喵`; line = pick(LINES.playerLose) }
        else if (whDead) { result = `🏆 大肥鱼负债了！她欠 ${fmtMoney(-wh)}，你 ${fmtShort(you)} 稳稳站着`; line = pick(LINES.goalWin) }
        else if (youReach && !whReach) { result = `🏆 传说局：你先摸到 ${fmtShort(GOAL)}！`; line = pick(LINES.goalWin) }
        else if (!youReach && whReach) { result = `🐠 大肥鱼先摸到 ${fmtShort(GOAL)}（你 ${fmtShort(you)}）……她飘了`; line = pick(LINES.goalLose) }
        else { result = `🏁 收摊：你 ${fmtShort(you)} vs 大肥鱼 ${fmtShort(wh)}`; line = pick(you >= wh ? LINES.playerWin : LINES.playerLose) }
      } else {
        const youDead = g.you.dead, whDead = g.whale.dead
        if (youDead && !whDead) { result = `💀 强平出局！爆仓就输，没什么好说的。大肥鱼 ${fmtMoney(wh)}`; line = pick(LINES.playerLose) }
        else if (!youDead && whDead) { result = `🏆 大肥鱼被强平了！你 ${fmtMoney(you)} 活着看到她爆仓`; line = pick(LINES.playerWin) }
        else if (youDead && whDead) { result = '双爆，同归于尽……算平局喵'; line = pick(LINES.draw) }
        else if (you > wh) { result = `🏆 你赢了！你 ${fmtMoney(you)} vs 大肥鱼 ${fmtMoney(wh)}`; line = pick(LINES.playerWin) }
        else if (you < wh) { result = `🐠 大肥鱼赢了：她 ${fmtMoney(wh)} vs 你 ${fmtMoney(you)}`; line = pick(LINES.playerLose) }
        else { result = `平局，双方都 ${fmtMoney(you)}`; line = pick(LINES.draw) }
      }
      g.result = result
      // 空中飞人 +1：归来模式里**你负债出局**才算飞一次（双负债是平局，不飞喵）
      if (g.mode === 'goal' && g.you.dead && !g.whale.dead) {
        ENGINE.flyer = writeFlyer(ENGINE.flyer + 1)
        g.result = `${result} —— 空中飞人第 ${ENGINE.flyer} 次`
      }
      record(g.mode === 'goal' && preYou >= GOAL ? 'goal' : you > wh ? 'win' : you < wh ? 'lose' : 'draw', you - wh)
      setSay(line); setRunning(false)
    }

    const posText = (a, pair, g) => {
      if (!a.pos) return `空仓 · 占用保证金 ${fmtMoney(a.locked)}`
      const { bid, ask } = quote(g, g.pi)
      const mark = a.pos.dir > 0 ? bid : ask
      const u = pnlOf(a.pos, mark, g.pi)
      return `${a.pos.dir > 0 ? '多单' : '空单'} ${a.pos.lot} 手 @ ${fmtPx(a.pos.entry, pair)}\n浮动 ${fmtMoney(u)} · 占用 ${fmtMoney(a.locked)}`
    }
    const fmtClock = (ms) => {
      if (!Number.isFinite(ms)) return '∞' // 重生之久留美归来：不限时喵
      const s = Math.ceil(ms / 1000)
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    function record(kind, delta) {
      try {
        const k = 'fx-arena-record'
        const r = JSON.parse(localStorage.getItem(k) || '{"win":0,"lose":0,"draw":0,"best":0}')
        r[kind] = (r[kind] || 0) + 1
        r.best = Math.max(r.best || 0, delta)
        localStorage.setItem(k, JSON.stringify(r))
      } catch { /* 无 localStorage 也无所谓 */ }
    }

    /* ───────────────────────── 画 K 线 ───────────────────────── */
    function drawChart(cv, g, pi) {
      const dpr = window.devicePixelRatio || 1
      const W = cv.clientWidth, H = cv.clientHeight
      if (!W || !H) return
      if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
        cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr)
      }
      const ctx = cv.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      const cs = g.candles.slice(-CANDLES)
      const pair = PAIRS[typeof g.pi === 'number' ? g.pi : pi]
      let hi = -Infinity, lo = Infinity
      for (const c of cs) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l) }
      const pad = (hi - lo) * 0.08 || pair.vol * 4
      hi += pad; lo -= pad
      const PL = 6, PR = 64, PT = 10, PB = 10
      const cw = (W - PL - PR) / cs.length
      const y = (p) => PT + (hi - p) / (hi - lo) * (H - PT - PB)

      // 网格 + 价格轴
      ctx.strokeStyle = 'rgba(127,127,127,.13)'; ctx.lineWidth = 1
      ctx.fillStyle = 'rgba(154,160,166,.9)'; ctx.font = '10px ui-monospace,monospace'
      for (let i = 0; i <= 4; i++) {
        const p = lo + (hi - lo) * i / 4, yy = y(p)
        ctx.beginPath(); ctx.moveTo(PL, yy); ctx.lineTo(W - PR, yy); ctx.stroke()
        ctx.fillText(fmtPx(p, pair), W - PR + 6, yy + 3)
      }
      // 现价线
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(167,139,250,.6)'
      ctx.beginPath(); ctx.moveTo(PL, y(g.px)); ctx.lineTo(W - PR, y(g.px)); ctx.stroke(); ctx.setLineDash([])

      const bodyW = Math.max(2, cw * 0.62)
      cs.forEach((c, i) => {
        const cx = PL + cw * i + cw / 2
        const up = c.c >= c.o
        ctx.strokeStyle = up ? '#22c55e' : '#ef4444'; ctx.fillStyle = up ? '#22c55e' : '#ef4444'
        ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke()
        const t = y(Math.max(c.o, c.c)), b = y(Math.min(c.o, c.c))
        ctx.fillRect(cx - bodyW / 2, t, bodyW, Math.max(1, b - t))
      })

      // 大肥鱼持仓的入场线（青）
      const wp = g.whale && g.whale.pos
      if (wp) {
        ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(56,189,248,.85)'; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(PL, y(wp.entry)); ctx.lineTo(W - PR, y(wp.entry)); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = 'rgba(56,189,248,.95)'
        ctx.fillText(`鱼 ${wp.dir > 0 ? '多' : '空'}@${fmtPx(wp.entry, pair)}`, PL + 4, y(wp.entry) - 4)
      }
      // 你的入场线（紫）
      const yp = g.you && g.you.pos
      if (yp) {
        ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(167,139,250,.9)'; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.moveTo(PL, y(yp.entry)); ctx.lineTo(W - PR, y(yp.entry)); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = 'rgba(167,139,250,.95)'
        ctx.fillText(`你 ${yp.dir > 0 ? '多' : '空'}@${fmtPx(yp.entry, pair)}`, PL + 4, y(yp.entry) + 11)
      }
    }

    /* ───────────────────────── 入口图标 ───────────────────────── */
    function EntryIcon() {
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 4.5, stroke: 'currentColor', 'stroke-width': 1.6 }),
        // 一根小阳线 + 一根小阴线，像 K 线
        h('path', { d: 'M7 13v5M7 8v5M5 11h4', stroke: '#22c55e', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
        h('path', { d: 'M12 9v7M12 6v3M10.5 9h3', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
        h('path', { d: 'M17 7v9M17 16l-2-2M17 16l2-2', stroke: '#38bdf8', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      )
    }

    /* ───────────────────────── 挂载 ───────────────────────── */
    // 调试钩子：scripts/selftest.mjs 在 Node 里 mock 掉 window/document/react 后，
    // 直接驱动引擎跑 90 秒行情做数值冒烟（浏览器里挂个只读对象，无副作用）。
    try { if (typeof window !== 'undefined') window.__fxArenaEngine = { freshState, step, quote, pnlOf, marginFor, drift, liquidated, PAIRS, GOAL, LEVS, DURS, roundMs, ENGINE, TICK_MS } } catch { /* 忽略 */ }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-fx-arena')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-fx-arena: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        const ENTRY_ID = 'fx-arena'
        // ⚠️ 顺序很重要：宿主要求「选中一条 panellist 入口时，main 里必须有同 id 的面板，
        //    找不到会抛（且不改当前选择）」——所以先登记 main 面板，成功了才登记左侧图标。
        let mainOk = false
        try {
          slots.inject('main', () => slots.register(
            { name: 'main', key: ENTRY_ID },
            () => h(Arena),
          ))
          mainOk = true
        } catch (e) { /* 这个宿主没有 main keyed slot：左侧就不放入口，见下方兜底 */ }

        // ① 左侧图标条：登记一条入口（图标 + label）。选中后宿主按同一 id 渲染 main 面板。
        if (mainOk) {
          try {
            slots.inject('sidebar.panellist', () => slots.register(
              { name: 'sidebar.panellist', id: ENTRY_ID, order: 100, label: 'FX战士大肥鱼' },
              () => h(EntryIcon),
            ))
          } catch (e) { mainOk = false }
        }

        // ② 兜底：左侧放不了（槽位对不上）时，入口挂到「设置」页里，游戏本身照常能玩。
        if (!mainOk) {
          try {
            slots.inject('settings.section', () => slots.register(
              { name: 'settings.section', id: ENTRY_ID, order: 40, label: 'FX战士大肥鱼' },
              () => h(Arena),
            ))
          } catch (e) { /* 连设置槽也没有：样式照常在，别的什么都不影响 */ }
        }
      },
    }
  },
})
