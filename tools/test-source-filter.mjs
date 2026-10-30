/**
 * 内容来源与过滤测试（2026-10-30 重构）：sourceMode / filterAds / filterSpam / blockWords / minUpFans
 * + 配额上限抬升（perRoundMax 0–30 默认 5、perDayMax 0–240 默认 30）。
 * 用法：node test-source-filter.mjs [插件目录]
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PLUGIN =
  process.argv[2] ||
  join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const ok = (c, l, e) => {
  if (c) console.log('  ✓ ' + l)
  else { failures++; console.log('  ✗ ' + l + (e ? '  → ' + e : '')) }
}

async function loadWith(cfgJson) {
  const HOME = mkdtempSync(join(tmpdir(), 'sourcefilter-'))
  const STATE = join(HOME, 'bili-duty')
  mkdirSync(STATE, { recursive: true })
  writeFileSync(join(STATE, 'config.json'), JSON.stringify(cfgJson), 'utf8')
  const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href + '?t=' + Date.now())
  const routes = []
  const ctx = {
    get: (n) => (n === 'dshHomePath' ? (name) => join(HOME, name) : undefined),
    effect: (f) => { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => {}, debounce: (f) => f,
    settings: { describe: () => [], update: async () => {} },
    tools: { register: () => () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
  mod.apply(ctx, {})
  const call = async (method, url, body) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
    const req = { method, url, headers: {}, on(ev, fn) { if (ev === 'data') fn(Buffer.from(body ?? '')); if (ev === 'end') fn() } }
    await routes[0].handler(req, res)
    return JSON.parse(res.body)
  }
  return {
    call,
    cleanup: () => rmSync(HOME, { recursive: true, force: true }),
  }
}

console.log('=== ① 全新安装：来源与过滤默认值 + 配额自洽 ===')
{
  const { call, cleanup } = await loadWith({})
  const st = await call('GET', '/api/bili-pond/status')
  const c = st.config
  console.log('   →', JSON.stringify({ sourceMode: c.sourceMode, filterAds: c.filterAds, filterSpam: c.filterSpam, blockWords: c.blockWords, minUpFans: c.minUpFans, perRoundMax: c.perRoundMax, perDayMax: c.perDayMax }))
  ok(c.sourceMode === 'feed', '默认 sourceMode=feed（只看推荐流）', String(c.sourceMode))
  ok(c.filterAds === true, '默认 filterAds=true', String(c.filterAds))
  ok(c.filterSpam === true, '默认 filterSpam=true', String(c.filterSpam))
  ok(Array.isArray(c.blockWords) && c.blockWords.length === 0, '默认 blockWords=[]', JSON.stringify(c.blockWords))
  ok(c.minUpFans === 0, '默认 minUpFans=0（不查粉丝数）', String(c.minUpFans))
  ok(c.perRoundMax === 5, '默认 perRoundMax=5（2026-10-30 从 3 抬升）', String(c.perRoundMax))
  ok(c.perDayMax === 30, '默认 perDayMax=30（2026-10-30 从 18 抬升）', String(c.perDayMax))
  ok((c.autoRunsPerDay || 0) * (c.perRoundMax || 0) <= (c.perDayMax || 0), '默认值自洽：autoRunsPerDay × perRoundMax ≤ perDayMax')
  cleanup()
}

console.log('\n=== ② POST /config：钳制与清洗 ===')
{
  const { call, cleanup } = await loadWith({})
  const r = await call('POST', '/api/bili-pond/config', JSON.stringify({
    perRoundMax: 50, perDayMax: 9999, sourceMode: 'bogus',
    blockWords: ['  原神 ', '', '崩铁', 42], minUpFans: -5,
  }))
  const c = r.config || {}
  console.log('   →', JSON.stringify({ perRoundMax: c.perRoundMax, perDayMax: c.perDayMax, sourceMode: c.sourceMode, blockWords: c.blockWords, minUpFans: c.minUpFans }))
  ok(c.perRoundMax === 30, 'perRoundMax 50 → 钳到 30', String(c.perRoundMax))
  ok(c.perDayMax === 240, 'perDayMax 9999 → 钳到 240', String(c.perDayMax))
  ok(c.sourceMode === 'feed', 'sourceMode 非法值 → 回 feed', String(c.sourceMode))
  ok(JSON.stringify(c.blockWords) === JSON.stringify(['原神', '崩铁']), 'blockWords 清洗：去空白/去空串/去非字符串', JSON.stringify(c.blockWords))
  ok(c.minUpFans === 0, 'minUpFans 负数 → 0', String(c.minUpFans))
  cleanup()
}

console.log('\n=== ③ POST /config：合法值能写进去 ===')
{
  const { call, cleanup } = await loadWith({})
  await call('POST', '/api/bili-pond/config', JSON.stringify({ sourceMode: 'mixed', filterSpam: false }))
  const st = await call('GET', '/api/bili-pond/status')
  const c = st.config
  ok(c.sourceMode === 'mixed', 'sourceMode=mixed 能写入', String(c.sourceMode))
  ok(c.filterSpam === false, 'filterSpam=false 能写入', String(c.filterSpam))
  ok(c.filterAds === true, 'filterSpam 关掉不影响 filterAds', String(c.filterAds))
  cleanup()
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)
