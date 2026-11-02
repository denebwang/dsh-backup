/**
 * fork 增量：配置变更触发。
 *
 * 上游只有「宿主版本变化 → 升级前快照」和「定时自动备份」，没有"改配置就留一份"。
 * 这里补上：监听 profiles 下配置类文件的写入，静默若干秒后调用注入的 run()。
 *
 * 设计约束（与上游保持一致的降级哲学）：
 *   - 任何失败只打日志，绝不影响宿主；
 *   - 用指纹去重，避免一次 pnpm install 连续写十几个文件触发多次备份；
 *   - 只监听配置类扩展名，会话/存储每步都在写，纳入会形成快照风暴。
 * @module dsh-backup/lib/trigger
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CONFIG_EXTS = new Set(['.json', '.yml', '.yaml'])
const MAX_WATCH_DEPTH = 6

function collectConfigFiles(dir, out, depth = 0) {
  if (depth > MAX_WATCH_DEPTH) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectConfigFiles(p, out, depth + 1)
    else if (e.isFile() && CONFIG_EXTS.has(path.extname(e.name).toLowerCase())) out.push(p)
  }
}

/** 配置类文件的内容指纹：路径 + 大小 + mtime。 */
export function configFingerprint(dshHome) {
  const files = []
  collectConfigFiles(path.join(dshHome, 'profiles'), files)
  const cred = path.join(dshHome, '.credentials.yaml')
  try {
    if (fs.statSync(cred).isFile()) files.push(cred)
  } catch {
    /* 缺文件正常 */
  }
  const lines = files.map((f) => {
    try {
      const st = fs.statSync(f)
      return path.relative(dshHome, f) + '|' + st.size + '|' + st.mtimeMs
    } catch {
      return path.relative(dshHome, f) + '|gone'
    }
  })
  lines.sort()
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * 启动配置监听。
 * @param {object} o
 * @param {string} o.dshHome - DSH 数据目录
 * @param {() => object} o.getConfig - 读取生效配置（watchConfig/debounceSeconds）
 * @param {(reason: string) => Promise<unknown>} o.run - 触发备份
 * @param {Console} [o.log]
 * @returns {() => void} disposer
 */
export function startConfigWatcher({ dshHome, getConfig, run, log = console }) {
  const target = path.join(dshHome, 'profiles')
  let watcher = null
  let timer = null
  let disposed = false
  let lastFp = configFingerprint(dshHome)

  const fire = () => {
    timer = null
    if (disposed) return
    const cfg = getConfig() || {}
    if (cfg.watchConfig === false) return
    const fp = configFingerprint(dshHome)
    if (fp === lastFp) return
    lastFp = fp
    Promise.resolve()
      .then(() => run('config-change'))
      .catch((err) => log.warn?.('[dsh-backup] 配置变更触发备份失败: ' + String(err?.message || err)))
  }

  try {
    watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
      if (disposed || !filename) return
      const name = String(filename)
      if (!CONFIG_EXTS.has(path.extname(name).toLowerCase())) return
      if (name.includes('node_modules')) return
      const cfg = getConfig() || {}
      const debounce = Math.max(3, Number(cfg.debounceSeconds) || 20) * 1000
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, debounce)
    })
    log.info?.('[dsh-backup] 已监听配置变更: ' + target)
  } catch (err) {
    log.warn?.('[dsh-backup] 无法监听配置目录: ' + String(err?.message || err))
    return () => {}
  }

  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = null
    try {
      watcher?.close()
    } catch {
      /* 已关闭 */
    }
    watcher = null
  }
}
