/**
 * dsh-fx-arena —— FX战士大肥鱼 · DSH 插件（host 半端）
 * ============================================================================
 * 这个插件**几乎全在浏览器里跑**（client.js）：
 *   · 价格是本地模拟的随机游走（GBM + 偶发消息冲击），不联网、不碰真钱；
 *   · 对手「大肥鱼 / 鲸鲸」是一个本地算法交易者，和玩家看同一条价格流；
 *   · 入口（左侧图标条）也由 client.js 通过 `sidebar.panellist` 槽位注册。
 *
 * 所以 host 这边**不注册任何工具、不挂任何 HTTP 接口** —— 挂了反而在没有
 * webServer 的 headless profile 里给插件拖后腿。
 *
 * 但 DSH 约定：包声明了 `main` ⇒ 必须有一个能安全 import 的入口，且
 * **apply() 绝不抛异常**（抛了会带走整个 dsh 进程）。这里就守这条底线：
 * 什么都不做，但绝不炸。
 * ============================================================================
 */

export const name = 'fx-arena'

/** 空实现：游戏全在 client 半端。保留 async 签名以符合宿主调用约定。 */
export async function apply(_ctx, _config) {
  // 故意留空 —— 见文件头。任何初始化都不在这里做，避免 headless 环境报错。
}

/** 给宿主/排查看的元信息（不注册成工具） */
export function describe() {
  return {
    name,
    title: 'FX战士大肥鱼',
    entry: 'sidebar.panellist', // 左侧图标条
    opponent: '大肥鱼（鲸鲸）',
    realtime: true,
  }
}

// 直接 `node index.js` 时打印一下（方便人工排查，不进 DSH 也无副作用）
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  console.log(JSON.stringify(describe(), null, 2))
}
