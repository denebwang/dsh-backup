#!/usr/bin/env node
/**
 * dsh-backup fork：宿主关闭时的 OS 级兜底备份。
 *
 * 与宿主内定时的关系是「让位」：只要检测到最近有成功备份（宿主内 auto 或本脚本自己），
 * 就直接退出，不做重复劳动。DSH 长时间未启动时才真正落一份归档。
 *
 * 补齐上游自动备份的三个缺口：
 *   1. 凭据脱敏 —— .credentials.yaml / .env / qq-bridge/config.json 不进归档
 *   2. sha256 边车 —— 可校验
 *   3. .meta.json —— 恢复预检用（主机/家目录/时间）
 *
 * 归档命名 dsh-os-<stamp>.tar.gz：已加入上游 SNAPSHOT_PREFIXES，
 * 因此不进用户列表、不参与主轮转，但可用显式前缀恢复。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const CONF = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'os-fallback.json')
let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(CONF, 'utf8')) } catch (e) { console.error('[os-fallback] 读不到配置: ' + CONF); process.exit(1) }

const DSH_HOME = cfg.dshHome
const DEST = cfg.dest
const KEEP = Number(cfg.keep) > 0 ? Number(cfg.keep) : 7
const MIN_HOURS = cfg.minIntervalHours === undefined || cfg.minIntervalHours === null ? 2 : Math.max(0, Number(cfg.minIntervalHours) || 0)
// 上游默认脱敏清单 + undo 插件的明文 vault（后者的文件名是 <hash>.env，
// 上游的 *.env 精确名模式匹配不到，会漏进归档）。
const REDACT_BASE = ['.credentials.yaml', '.env', 'qq-bridge/config.json', 'undo-snapshots/auto/env-vault']
const REDACT = Array.isArray(cfg.redact) && cfg.redact.length
  ? [...new Set([...cfg.redact, 'undo-snapshots/auto/env-vault'])]
  : REDACT_BASE
const log = (m) => console.log(new Date().toISOString() + ' [os-fallback] ' + m)
const hoursOf = (ms) => ms / 3600000

fs.mkdirSync(DEST, { recursive: true })

// ---- 1) 让位：宿主内定时最近成功过就跳过 ----
let hostRecent = false
try {
  const auto = JSON.parse(fs.readFileSync(path.join(DEST, 'auto.json'), 'utf8'))
  if (auto && auto.lastAutoAt) {
    const age = hoursOf(Date.now() - Date.parse(auto.lastAutoAt))
    if (Number.isFinite(age) && age < MIN_HOURS) {
      hostRecent = true
      log('宿主内定时 ' + age.toFixed(1) + ' 小时前刚备份过，让位跳过')
    }
  }
} catch { /* 没有 auto.json 说明宿主内定时没开过，继续 */ }
if (hostRecent) process.exit(0)

// ---- 2) 自己的上一次兜底也够新就跳过 ----
const osArchives = () => {
  try {
    return fs.readdirSync(DEST).filter((f) => /^dsh-os-.*\.tar\.gz$/.test(f)).sort()
  } catch {
    return []
  }
}
const prev = osArchives()
if (prev.length) {
  let newest = 0
  for (const f of prev) {
    try { newest = Math.max(newest, fs.statSync(path.join(DEST, f)).mtimeMs) } catch { /* 忽略 */ }
  }
  if (newest && hoursOf(Date.now() - newest) < MIN_HOURS) {
    log('上次兜底不足 ' + MIN_HOURS + ' 小时，跳过')
    process.exit(0)
  }
}

// ---- 3) 打包（脱敏 + 排除可重建缓存）----
const now = new Date()
const pad = (n, w) => String(n).padStart(w, '0')
const stamp = '' + now.getFullYear() + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) + '-' + pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2) + pad(now.getMilliseconds(), 3)
const name = 'dsh-os-' + stamp + '.tar.gz'
const out = path.join(DEST, name)
const base = path.basename(DSH_HOME)
const parent = path.dirname(DSH_HOME)

const args = ['--exclude=*node_modules*', '--exclude=.system']
for (const rel of REDACT) {
  args.push(
    '--exclude=' + base + '/' + rel,
    '--exclude=' + base + '/' + rel + '/*',
    '--exclude=*/' + rel,
    '--exclude=*/' + rel + '/*',
  )
}
for (const ex of (Array.isArray(cfg.exclude) ? cfg.exclude : [])) if (ex) args.push('--exclude=' + ex)
// Windows 的 GNU tar（msys）会把含盘符冒号的绝对路径当成远程归档（Cannot connect to D:），
// 所以 -f 只传文件名，工作目录设在 DEST。
args.push('-czf', name, '-C', parent, base)

log('开始兜底备份: ' + out)
const r = spawnSync('tar', args, { stdio: 'inherit', cwd: DEST })
if (r.status !== 0) {
  try { fs.rmSync(out, { force: true }) } catch { /* 忽略 */ }
  log('tar 失败，退出码 ' + r.status)
  process.exit(1)
}

// ---- 4) sha256 边车 ----
try {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(out, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let n
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  fs.closeSync(fd)
  fs.writeFileSync(out + '.sha256', h.digest('hex') + '  ' + out + '\n')
} catch (e) { log('写校验失败: ' + e.message) }

// ---- 5) meta 边车（恢复预检）----
try {
  fs.writeFileSync(out + '.meta.json', JSON.stringify({
    host: os.hostname(), home: os.homedir(), dshHome: DSH_HOME,
    createdAt: new Date().toISOString(), source: 'os-fallback',
  }, null, 0))
} catch (e) { log('写 meta 失败: ' + e.message) }

// ---- 6) 轮转（只动 dsh-os-*）----
const all = osArchives()
while (KEEP > 0 && all.length > KEEP) {
  const victim = all.shift()
  for (const suf of ['', '.sha256', '.meta.json']) {
    try { fs.rmSync(path.join(DEST, victim + suf), { force: true }) } catch { /* 忽略 */ }
  }
  log('轮转删除 ' + victim)
}
log('兜底备份完成: ' + out)
