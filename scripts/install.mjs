#!/usr/bin/env node
/**
 * scripts/install.mjs —— 把 dsh-fx-arena 装进本机 DSH（幂等、跨机器、带自检）
 * ============================================================================
 * 为什么这样写（都是别的插件踩过的坑）：
 *   · 不认死路径：插件目录从本文件位置推、DSH_HOME 从环境变量/用户目录推，
 *     整个文件夹拷到别的电脑上，直接跑这个脚本就能装；
 *   · profile 不写死：自动扫描 <DSH_HOME>/profiles/*，哪个 profile 有
 *     dsh.profile.bundles 就装哪个（桌面版叫 desktop，headless 版不一定）；
 *   · 用户的 cordis.patch.yml 一行都不写：入口 insert 在包自带的 patch 里，
 *     卸载时跟着包消失，插件库卸载按钮能清干净；
 *   · 写 profile 的 package.json 之前先备份，写完整性再校验一遍。
 *
 * 用法：
 *   node scripts/install.mjs                # 自动检测，装到所有 profile
 *   node scripts/install.mjs --dry          # 只看会改什么
 *   node scripts/install.mjs --profiles desktop,headless
 *   node scripts/install.mjs --verify-only  # 只自检，不写任何东西
 *   DSH_HOME=/path/to/.dsh node scripts/install.mjs
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = resolve(HERE, '..')

/** 从任意位置推断 DSH 家目录（跟 DSH 自己的规则一致：DSH_HOME 优先） */
export function detectHome(env = process.env, home = homedir()) {
  return resolve(env.DSH_HOME || join(home, '.dsh'))
}

/** 扫描 <home>/profiles/*，返回「有 dsh.profile.bundles 的 profile」 */
export function listProfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) continue
    try {
      const m = JSON.parse(readFileSync(pkgFile, 'utf8'))
      if (Array.isArray(m?.dsh?.profile?.bundles)) out.push({ name, dir, manifest: m })
    } catch { /* 坏掉的 profile 跳过，不拖累别人 */ }
  }
  return out
}

const posix = (p) => String(p).replace(/\\/g, '/')

/** 插件包自身的启动级自检（缺 ./client 出口 = 整台 DSH 起不来） */
export function checkBundle(dir = PLUGIN_DIR) {
  const problems = []
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) { problems.push(`package.json 读不了：${e.message}`) }
  if (pkg) {
    if (!pkg.exports?.['.']) problems.push('package.json 缺 exports["."]')
    if (!pkg.exports?.['./client']) problems.push('package.json 缺 exports["./client"]（声明了 dsh.client 就必须有）')
    else if (!existsSync(join(dir, pkg.exports['./client']))) problems.push(`./client 指向的文件不存在：${pkg.exports['./client']}`)
    const patch = pkg?.dsh?.bundle?.patch
    if (!patch) problems.push('package.json 缺 dsh.bundle.patch')
    else {
      const pf = join(dir, patch)
      if (!existsSync(pf)) problems.push(`dsh.bundle.patch 指向的文件不存在：${patch}`)
      else {
        const body = readFileSync(pf, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n')
        if (!body.startsWith('- insert:')) problems.push('cordis.patch.yml 不是合法的 - insert: 数组')
        // insert 里 id 是插件 id（可以和包名不同），name 才是包名
        if (!new RegExp(`name:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(body)) problems.push(`cordis.patch.yml 里没有 name: ${pkg.name}`)
      }
    }
  }
  return { ok: problems.length === 0, problems, pkg }
}

/** 把本包登记进一个 profile：junction + dependencies(link:) + bundles */
export function installProfile({ dir, dry = false, log = () => {} }) {
  const pkgFile = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const name = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).name
  const nm = join(dir, 'node_modules')
  const link = join(nm, name)
  const spec = `link:${posix(PLUGIN_DIR)}`

  // ① 链接（Windows 用 junction，别的系统用目录软链）
  let linked = false
  try { linked = !!lstatSync(link) } catch { linked = false }
  if (!linked) {
    if (dry) log(`  · [dry] 会建链接 → ${posix(link)}`)
    else {
      mkdirSync(nm, { recursive: true })
      try { symlinkSync(PLUGIN_DIR, link, process.platform === 'win32' ? 'junction' : 'dir'); log(`  · 链接建好 → ${posix(link)}`) }
      catch (e) { log(`  · ⚠️ 建链接失败（${e?.message ?? e}）——插件库可能看不到它`) }
    }
  } else log(`  · 链接已存在（${name}）`)

  // ② 依赖 + bundles
  const changed = []
  manifest.dependencies = manifest.dependencies || {}
  if (manifest.dependencies[name] !== spec) { manifest.dependencies[name] = spec; changed.push('dependencies') }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { ok: false, why: '这个 profile 没有 dsh.profile.bundles', changed }
  if (!bundles.includes(name)) { bundles.push(name); changed.push('bundles') }

  if (!dry && changed.length) {
    // 写前备份（只留最近一份）
    try { copyFileSync(pkgFile, `${pkgFile}.bak-fxarena`) } catch { /* 备份失败也继续，但不静默 */ }
    writeFileSync(pkgFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    // 写完立刻读回校验，坏 JSON 就让用户知道
    try { JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (e) {
      copyFileSync(`${pkgFile}.bak-fxarena`, pkgFile)
      return { ok: false, why: `写坏了 package.json，已自动还原：${e.message}`, changed }
    }
    log(`  · 已登记：${changed.join(' + ')}`)
  } else if (!changed.length) log('  · 依赖与 bundles 都已登记')
  return { ok: true, changed }
}

/** 装完回读：确认 bundles / 依赖 / 链接都在 */
export function verifyProfile({ dir }) {
  const pkgFile = join(dir, 'package.json')
  const name = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).name
  const out = []
  try {
    const m = JSON.parse(readFileSync(pkgFile, 'utf8'))
    out.push({ ok: (m?.dsh?.profile?.bundles || []).includes(name), why: 'bundles 里在' , what: 'bundles' })
    out.push({ ok: !!m?.dependencies?.[name], why: 'dependencies 里在', what: 'dependencies' })
  } catch (e) { out.push({ ok: false, why: `package.json 读不了：${e.message}`, what: 'package.json' }) }
  try { out.push({ ok: !!lstatSync(join(dir, 'node_modules', name)), why: 'node_modules 链接在', what: 'link' }) } catch { out.push({ ok: false, why: 'node_modules 链接不在', what: 'link' }) }
  return out
}

/* ───────────── CLI ───────────── */
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href

if (isMain) {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const verifyOnly = argv.includes('--verify-only')
  const pIdx = argv.indexOf('--profiles')
  const wantProfiles = pIdx >= 0 ? String(argv[pIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null
  const log = (...a) => console.log(...a)

  const home = detectHome()
  log(`插件目录：${posix(PLUGIN_DIR)}`)
  log(`DSH_HOME：${posix(home)}`)

  // 0. 先自检本包（启动级问题必须拦在这里）
  const self = checkBundle()
  if (!self.ok) {
    log('\n❌ 插件包自身不自洽，先别装：')
    for (const p of self.problems) log(`   · ${p}`)
    process.exit(1)
  }
  log('✓ 包清单自洽（bundle patch / ./client 出口都在）')

  if (verifyOnly) {
    const profiles = listProfiles(home)
    if (!profiles.length) { log('\n⚠️ 没找到任何带 dsh.profile.bundles 的 profile'); process.exit(1) }
    let bad = 0
    for (const pr of profiles) {
      log(`\n[${pr.name}] 自检：`)
      for (const r of verifyProfile(pr)) { if (!r.ok) bad++; log(`  ${r.ok ? '✓' : '✗'} ${r.why}`) }
    }
    process.exit(bad ? 1 : 0)
  }

  const all = listProfiles(home)
  if (!all.length) {
    log(`\n⚠️ ${posix(home)} 下没有找到 DSH profile。`)
    log('   如果 DSH 装在别处，先设 DSH_HOME，例如：')
    log('     Windows:  set DSH_HOME=C:\\Users\\你\\.dsh && node scripts\\install.mjs')
    log('     macOS/Linux:  DSH_HOME=~/.dsh node scripts/install.mjs')
    process.exit(1)
  }
  const targets = wantProfiles ? all.filter((p) => wantProfiles.includes(p.name)) : all
  log(`\n发现 ${all.length} 个 profile：${all.map((p) => p.name).join(', ')}`)
  if (wantProfiles && !targets.length) { log('⚠️ --profiles 指定的名字一个都没匹配上'); process.exit(1) }

  let bad = 0
  for (const pr of targets) {
    log(`\n[${pr.name}]`)
    if (!dry) {
      const r = installProfile({ dir: pr.dir, dry, log })
      if (!r.ok) { log(`  ⚠️ ${r.why}`); bad++; continue }
      for (const v of verifyProfile({ dir: pr.dir })) { if (!v.ok) { bad++; log(`  ✗ ${v.why}`) } }
      if (bad === 0) log('  ✓ 安装后自检通过')
    } else {
      installProfile({ dir: pr.dir, dry, log })
    }
  }

  log('\n完成。')
  log('  · 生效：**重启一次 DSH**（bundles 是启动时组合的）')
  log('  · 验证：左侧图标条出现「FX战士大肥鱼」；点进去按「开始切磋」')
  log('  · 自检：node scripts/install.mjs --verify-only')
  log('  · 卸载：插件库里点「卸载」；兜底 node scripts/uninstall.mjs --yes')
  process.exit(bad ? 1 : 0)
}
