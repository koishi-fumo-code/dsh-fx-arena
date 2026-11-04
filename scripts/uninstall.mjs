#!/usr/bin/env node
/**
 * scripts/uninstall.mjs —— 手动卸载（插件库卸载按钮用不了时的兜底）
 * ============================================================================
 * 正常情况下**不需要它**：插件登记成 bundle + dependency 后，插件库里点「卸载」就干净了。
 * 这里只处理两种边角：① 插件库显示「未安装」但东西还在；② headless 这种没界面的 profile。
 *
 * 做的事（和插件管理器的卸载一一对应）：
 *   ① dependencies 里删掉 dsh-fx-arena
 *   ② dsh.profile.bundles 里删掉 dsh-fx-arena
 *   ③ node_modules 里的链接删掉（**只删链接，绝不递归删目标目录**）
 *   ④ 用户的 cordis.patch.yml 一个字不动 —— 本插件的入口在包自带 patch 里，
 *      那里本来就不该有本插件的行；真发现了，只报告，不擅自改写（市场规矩）。
 *
 * 用法：node scripts/uninstall.mjs --yes [--profiles desktop,headless]
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const PKG = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name

// 和 install.mjs 用同一套探测：DSH_HOME 由环境变量推，profile 自动枚举
const { detectHome, listProfiles } = await import(new URL('./install.mjs', import.meta.url).href)
const dshHome = detectHome()

const argv = process.argv.slice(2)
const yes = argv.includes('--yes')
if (!yes) { console.log('这是会改 profile 的操作，加 --yes 确认：\n  node scripts/uninstall.mjs --yes'); process.exit(1) }
const pIdx = argv.indexOf('--profiles')
const profiles = pIdx >= 0
  ? String(argv[pIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : listProfiles(dshHome).map((p) => p.name) // 不给就全卸，换机器也一致
const posix = (p) => String(p).replace(/\\/g, '/')
const log = (...a) => console.log(...a)

log(`插件目录（**不会删**）：${posix(pluginDir)}`)

for (const profile of profiles) {
  const dir = join(dshHome, 'profiles', profile)
  if (!existsSync(dir)) { log(`\n[${profile}] ⚠️ 没有这个 profile，跳过`); continue }
  log(`\n[${profile}]`)

  // ①② package.json：删 dependency + bundle
  const packageFile = join(dir, 'package.json')
  if (existsSync(packageFile)) {
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
    const changed = []
    if (manifest.dependencies && manifest.dependencies[PKG]) { delete manifest.dependencies[PKG]; changed.push('dependencies') }
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PKG)) {
      manifest.dsh.profile.bundles = bundles.filter((b) => b !== PKG)
      changed.push('bundles')
    }
    if (changed.length) {
      writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      log(`  · 已移除：${changed.join(' + ')}`)
    } else log('  · dependencies / bundles 里没有它（干净）')
  } else log('  · 没有 package.json，跳过')

  // ③ 链接：只删这条 link 本身（recursive:false 防止顺着 junction 删掉插件源码目录）
  const link = join(dir, 'node_modules', PKG)
  try {
    lstatSync(link)
    rmSync(link, { recursive: false, force: true })
    log('  · 已删 node_modules 里的链接')
  } catch { /* 链接不存在 = 已干净 */ }

  // ④ 用户 patch：只查不改
  const patchFile = join(dir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const rows = readFileSync(patchFile, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#') && /fx-arena/.test(l))
    if (rows.length) log(`  · ⚠️ 用户 patch 里有 ${rows.length} 行提到 fx-arena（本插件不该写这里）。卸载不会替你改，需要的话手动删。`)
    else log('  · 用户 patch 里没有 fx-arena 行（干净）')
  }
}

log('\n完成。本插件没有数据目录（战绩在浏览器 localStorage，想清就清）。')
