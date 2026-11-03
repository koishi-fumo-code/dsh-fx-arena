#!/usr/bin/env node
/**
 * scripts/install.mjs —— 把 dsh-fx-arena 登记成 DSH 的正经插件（幂等，可反复跑）
 * ============================================================================
 * 规矩抄 dsh-feiyu-kb/scripts/install.mjs（那边踩过的坑这里都躲开）：
 *   · 用户的 cordis.patch.yml **一行都不写** —— 入口 insert 在包自带的
 *     cordis.patch.yml 里，卸载时跟着包消失，天然干净；
 *   · profile 的 package.json 只动两处：dependencies 加 link:<本包>、
 *     dsh.profile.bundles 加包名 —— 这正是插件管理器「卸载」负责还原的两处。
 *
 * 用法：node scripts/install.mjs [--profiles desktop,headless] [--dry]
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const PKG = pkg.name

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const pIdx = argv.indexOf('--profiles')
const profiles = (pIdx >= 0 ? String(argv[pIdx + 1] || '') : 'desktop')
  .split(',').map((s) => s.trim()).filter(Boolean)

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const log = (...a) => console.log(...a)
const posix = (p) => String(p).replace(/\\/g, '/')

/** 写 package.json：dependency(link:) + bundles */
function registerPackage(packageFile, name, dir) {
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const changed = []
  manifest.dependencies = manifest.dependencies || {}
  const spec = `link:${posix(dir)}`
  if (manifest.dependencies[name] !== spec) {
    manifest.dependencies[name] = spec
    changed.push('dependencies')
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { ok: false, why: '这份 profile 没有 dsh.profile.bundles', changed }
  if (!bundles.includes(name)) { bundles.push(name); changed.push('bundles') }
  if (changed.length) writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { ok: true, changed }
}

log(`插件目录：${posix(pluginDir)}`)
log(`DSH_HOME：${posix(dshHome)}`)

for (const profile of profiles) {
  const dir = join(dshHome, 'profiles', profile)
  if (!existsSync(dir)) { log(`⚠️ 跳过 ${profile}：没有这个 profile（${dir}）`); continue }
  log(`\n[${profile}]`)

  // ① junction（pnpm 未接管前的兜底；接管后 pnpm 会自己建链接）
  const nm = join(dir, 'node_modules')
  const link = join(nm, PKG)
  if (!dry) mkdirSync(nm, { recursive: true })
  let linked = false
  try { const st = lstatSync(link); linked = st.isSymbolicLink() || st.isDirectory() } catch { linked = false }
  if (linked) log(`  · 链接已存在（${PKG}）`)
  else if (dry) log(`  · [dry] 会建 junction → ${link}`)
  else {
    try { symlinkSync(pluginDir, link, 'junction'); log(`  · junction 建好 → ${link}`) }
    catch (e) { log(`  · ⚠️ junction 失败（${e?.message ?? e}）`) }
  }

  // ② 依赖 + bundles
  const packageFile = join(dir, 'package.json')
  if (!existsSync(packageFile)) { log(`  · ⚠️ 没有 ${packageFile}，跳过登记`); continue }
  if (dry) { log('  · [dry] 会写 dependencies(link:) + dsh.profile.bundles'); continue }
  const r = registerPackage(packageFile, PKG, pluginDir)
  if (!r.ok) log(`  · ⚠️ ${r.why}（插件库不会显示它）`)
  else log(r.changed.length ? `  · 已登记：${r.changed.join(' + ')}` : '  · 依赖与 bundles 都已登记')
}

log('\n完成。')
log('  生效：**重启一次 DSH**（bundles 是启动时组合的）。')
log('  验证：左侧图标条应出现「FX战士大肥鱼」；点它进面板，按「开始切磋」。')
log('  卸载：插件库里点「卸载」即可；兜底跑 node scripts/uninstall.mjs --yes')
