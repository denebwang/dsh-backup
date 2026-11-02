/**
 * fork 增量：OS 级计划任务（兜底层）。
 *
 * 职责边界：宿主内定时是主备份；本模块只在 DSH 关闭/崩溃时补位。
 * 具体“让位”逻辑在 os-fallback.mjs 里（检测到最近有成功备份就直接退出）。
 *
 * 只管理 Description 带 `dsh-backup-os:` 前缀的任务；别人的同名任务一律不动。
 * 注册不需要管理员权限（任务跑在用户自己的会话里）。
 * @module dsh-backup/lib/system-task
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const MARK = 'dsh-backup-os:'
const TASK_NAME = 'DSH Backup (OS layer)'
const SCRIPT_DIR = path.join(os.homedir(), '.dsh-backup-task')
const SENSITIVE_DEFAULTS = ['.credentials.yaml', '.env', 'qq-bridge/config.json', 'undo-snapshots/auto/env-vault']

function runPs(script) {
  const encoded = Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 90000,
  })
}

const esc = (v) => String(v).replace(/'/g, "''")

/**
 * 找可用的 node 可执行文件。跨机器时 PATH 最可靠；只接受能跑 `--version` 的真 node
 * （Electron 的可执行文件需要 ELECTRON_RUN_AS_NODE=1，不能直接当 node 用）。
 * @returns {string|null} 找不到返回 null，调用方负责降级
 */
export function detectNode() {
  const candidates = []
  if (process.env.DSH_BACKUP_NODE) candidates.push(process.env.DSH_BACKUP_NODE)
  try {
    const probe = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    for (const line of probe.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim())
  } catch { /* PATH 里没有 */ }
  candidates.push(
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    '/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node',
  )
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue
      const v = execFileSync(c, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
      if (/^v\d+\./.test(v)) return c
    } catch { /* 换下一个 */ }
  }
  return null
}

function resolveDest(cfg) {
  const raw = String((cfg && cfg.destination) || path.join(os.homedir(), 'Desktop', 'DSH Backups'))
  return path.resolve(raw.replace(/^~(?=[\\/]|$)/, os.homedir()))
}

function resolveRedact(cfg) {
  const r = cfg && cfg.redact !== undefined ? cfg.redact : SENSITIVE_DEFAULTS
  if (r === false || r === 'off' || r === 'none') return []
  if (Array.isArray(r)) return r.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return SENSITIVE_DEFAULTS
}

/** 部署兜底脚本与配置（每次挂载刷新）。 */
export function deployFallback({ dshHome, cfg }) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true })
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'os-fallback.mjs')
  const script = path.join(SCRIPT_DIR, 'backup.mjs')
  fs.copyFileSync(src, script)
  const conf = {
    dshHome,
    dest: resolveDest(cfg),
    keep: Number(cfg && cfg.keep) > 0 ? Number(cfg.keep) : 7,
    minIntervalHours: Number(cfg && cfg.osMinIntervalHours) > 0 ? Number(cfg.osMinIntervalHours) : 2,
    redact: resolveRedact(cfg),
    exclude: Array.isArray(cfg && cfg.exclude) ? cfg.exclude : [],
  }
  fs.writeFileSync(path.join(SCRIPT_DIR, 'os-fallback.json'), JSON.stringify(conf, null, 2))
  return { script, conf }
}

export function taskState() {
  try {
    const out = runPs("$t = Get-ScheduledTask -TaskName '" + esc(TASK_NAME) + "' -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'absent' }")
    return out.trim() || 'absent'
  } catch {
    return 'unknown'
  }
}

function isOurs() {
  try {
    const out = runPs("$t = Get-ScheduledTask -TaskName '" + esc(TASK_NAME) + "' -ErrorAction SilentlyContinue; if ($t) { $t.Description } else { '' }")
    return out.trim().startsWith(MARK)
  } catch {
    return false
  }
}

/** 装配系统任务（幂等）。返回 disposer。 */
export function provisionSystemTask({ dshHome, getConfig, log = console }) {
  if (process.platform !== 'win32') {
    // 非 Windows 不静默放弃：部署脚本并打印可直接粘贴的调度配置。
    let dep = null
    try {
      dep = deployFallback({ dshHome, cfg: getConfig() || {} })
    } catch { /* 部署失败不阻断 */ }
    if (dep) {
      const nodeBin = detectNode() || 'node'
      log.info?.('[dsh-backup] OS 兜底脚本已就绪（本平台需手动挂调度）: ' + dep.script)
      log.info?.('[dsh-backup] crontab: 0 * * * * ' + nodeBin + ' "' + dep.script + '" >> "$HOME/.dsh-backup-task/cron.log" 2>&1')
      log.info?.('[dsh-backup] 或 systemd user timer: ExecStart=' + nodeBin + ' ' + dep.script + ' / OnCalendar=hourly')
    }
    return () => {}
  }
  const cfg = getConfig() || {}
  let deployed
  try {
    deployed = deployFallback({ dshHome, cfg })
  } catch (err) {
    log.warn?.('[dsh-backup] 部署兜底脚本失败: ' + String(err && err.message ? err.message : err))
    return () => {}
  }
  const node = detectNode()
  if (!node) {
    log.warn?.('[dsh-backup] 找不到可用的 node 可执行文件，跳过 OS 兜底任务（可设置环境变量 DSH_BACKUP_NODE 指向 node）')
    return () => {}
  }
  const desc = MARK + ' hourly fallback with yield-to-host (managed by dsh-backup fork)'

  try {
    const probe = runPs("$t = Get-ScheduledTask -TaskName '" + esc(TASK_NAME) + "' -ErrorAction SilentlyContinue; if ($t) { 'EXISTS|' + $t.Description } else { 'ABSENT' }").trim()
    if (probe.startsWith('EXISTS|') && !probe.slice(7).startsWith(MARK)) {
      log.warn?.('[dsh-backup] 已存在同名任务且不属于本插件，跳过装配')
      return () => {}
    }
    const scriptPs = [
      "$ErrorActionPreference = 'Stop'",
      "$name = '" + esc(TASK_NAME) + "'",
      "$exe = '" + esc(node) + "'",
      "$arg = '\"" + esc(deployed.script) + "\"'",
      'if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }',
      '$action = New-ScheduledTaskAction -Execute $exe -Argument $arg',
      '$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)',
      '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description '" + esc(desc) + "' -Force | Out-Null",
      "'OK'",
    ].join('; ')
    runPs(scriptPs)
    log.info?.('[dsh-backup] 已装配系统计划任务: ' + TASK_NAME + '（脚本 ' + deployed.script + '，让位阈值 ' + deployed.conf.minIntervalHours + 'h）')
  } catch (err) {
    log.warn?.('[dsh-backup] 系统任务装配失败: ' + String(err && err.message ? err.message : err))
    return () => {}
  }

  return () => {
    const now = getConfig() || {}
    if (now.keepTaskOnUninstall) {
      log.info?.('[dsh-backup] keepTaskOnUninstall=true，保留系统任务')
      return
    }
    try {
      if (isOurs()) {
        runPs("Unregister-ScheduledTask -TaskName '" + esc(TASK_NAME) + "' -Confirm:$false -ErrorAction SilentlyContinue")
        log.info?.('[dsh-backup] 已反注册系统任务')
      }
    } catch (err) {
      log.warn?.('[dsh-backup] 反注册系统任务失败: ' + String(err && err.message ? err.message : err))
    }
  }
}
