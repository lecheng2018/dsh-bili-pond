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

console.log('\n=== ④ POST /config：合法值能写进去 ===')
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

console.log('\n=== ⑤ 关注动态档 + 放行词 + 推送 URL（2026-10-31 批量） ===')
{
  const { call, cleanup } = await loadWith({})
  const r = await call('POST', '/api/bili-pond/config', JSON.stringify({
    sourceMode: 'follow', allowWords: [' 学英语 ', ''], pushUrl: '  https://api.day.app/k/{title}/{body}  ',
  }))
  const c = r.config || {}
  console.log('   →', JSON.stringify({ sourceMode: c.sourceMode, allowWords: c.allowWords, pushUrl: c.pushUrl }))
  ok(c.sourceMode === 'follow', 'sourceMode=follow 是合法档位', String(c.sourceMode))
  ok(JSON.stringify(c.allowWords) === JSON.stringify(['学英语']), 'allowWords 清洗：去空白去空串', JSON.stringify(c.allowWords))
  ok(c.pushUrl === 'https://api.day.app/k/{title}/{body}', 'pushUrl 保存时去首尾空白', String(c.pushUrl))
  const bad = await call('POST', '/api/bili-pond/config', JSON.stringify({ sourceMode: 'bogus2' }))
  ok(bad.config?.sourceMode === 'feed', '非法档位回退 feed', String(bad.config?.sourceMode))
  cleanup()
}

console.log('\n=== ⑥ insights 聚合 + filter-log 路由（smoke） ===')
{
  const { call, cleanup } = await loadWith({})
  const ins = await call('GET', '/api/bili-pond/insights')
  ok(ins?.ok === true, 'insights 返回 ok', JSON.stringify(ins).slice(0, 80))
  ok(Array.isArray(ins?.days) && ins.days.length === 7, 'insights.days 是近 7 天', String(ins?.days?.length))
  ok(typeof ins?.totalPicked === 'number' && typeof ins?.totalTokens === 'number', 'insights 带挑中数与 token 合计')
  ok(typeof ins?.drift === 'number', 'insights 带漂移计数（新装应为 0）', String(ins?.drift))
  const fl = await call('GET', '/api/bili-pond/filter-log')
  ok(fl?.ok === true && Array.isArray(fl?.items) && fl.items.length === 0, 'filter-log 新装为空数组', JSON.stringify(fl).slice(0, 60))
  cleanup()
}

console.log('\n=== ⑥ status 带漂移字段 ===')
{
  const { call, cleanup } = await loadWith({})
  const st = await call('GET', '/api/bili-pond/status')
  ok(typeof st?.driftStreak === 'number', 'status 暴露 driftStreak', JSON.stringify(st?.driftStreak))
  cleanup()
}

console.log('=== ⑥ sources 多选（1.7.0）：老配置迁移 + 钳制 ===')
{
  const { call, cleanup } = await loadWith({ sourceMode: 'mixed' })
  const st = await call('GET', '/api/bili-pond/status')
  const c = st.config
  ok(JSON.stringify(c.sources) === JSON.stringify(['feed', 'keywords']), '老 sourceMode=mixed ⇒ sources=[feed,keywords]', JSON.stringify(c.sources))
  const r = await call('POST', '/api/bili-pond/config', JSON.stringify({ sources: ['feed', 'follow', 'bogus', 'feed'] }))
  const c2 = r.config || {}
  ok(JSON.stringify(c2.sources) === JSON.stringify(['feed', 'follow']), 'sources 钳制：去非法值、去重', JSON.stringify(c2.sources))
  const e = await call('POST', '/api/bili-pond/config', JSON.stringify({ sources: [] }))
  ok(JSON.stringify(e.config?.sources) === JSON.stringify(['feed']), 'sources 全空 ⇒ 回 [feed]', JSON.stringify(e.config?.sources))
  cleanup()
}

console.log('=== ⑦ 推送渠道：qqbot-dsh 已废弃（1.7.3 移除，钳回 off） ===')
{
  const { call, cleanup } = await loadWith({})
  const r = await call('POST', '/api/bili-pond/config', JSON.stringify({ pushChannel: 'qqbot-dsh' }))
  ok(r.config?.pushChannel === 'off', 'qqbot-dsh 已移除 ⇒ 钳回 off', String(r.config?.pushChannel))
  const pt = await call('POST', '/api/bili-pond/push-test', '{}')
  ok(pt?.ok === false, '渠道未配置 ⇒ 测试推送给人话报错', JSON.stringify(pt).slice(0, 90))
  cleanup()
}

console.log('=== ⑧ 每日推送时间钳制（1.8.0） ===')
{
  const { call, cleanup } = await loadWith({})
  const r = await call('POST', '/api/bili-pond/config', JSON.stringify({ pushDailyAt: '21:30' }))
  ok(r.config?.pushDailyAt === '21:30', '合法 HH:mm 保存', String(r.config?.pushDailyAt))
  const b = await call('POST', '/api/bili-pond/config', JSON.stringify({ pushDailyAt: '9:05' }))
  ok(b.config?.pushDailyAt === '09:05', '9:05 补零为 09:05', String(b.config?.pushDailyAt))
  const bad = await call('POST', '/api/bili-pond/config', JSON.stringify({ pushDailyAt: '25:99' }))
  ok(bad.config?.pushDailyAt === '', '非法时间清空（不推）', JSON.stringify(bad.config?.pushDailyAt))
  cleanup()
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)
