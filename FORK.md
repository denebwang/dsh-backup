# dsh-backup (fork) 行为说明

上游：`@xiaoyuyu6420/dsh-backup@0.14.2`（MIT）。本 fork 版本号 `0.14.2-fork.1`，改动面见文末。

## 1. 触发层（六路）

| 触发 | 归属 | 时机 | 归档前缀 | 保留 | 进用户列表 |
|---|---|---|---|---|---|
| 定时自动 | 上游 | 每 `auto` 小时（宿主内） | `dsh-` | `keep`（10） | ✅ |
| **配置变更** | fork | 配置写入后防抖 20s | `dsh-change-` | `changeKeep`（10） | ❌ 内部快照 |
| **稳定基线** | fork | 连续 30 分钟无变更 | `dsh-baseline-` | 2 | ❌ 内部快照 |
| 升级前 | 上游 | 宿主版本变化 | `dsh-pre-upgrade-` | 2 | ❌ |
| 恢复前 | 上游 | 每次 restore | `dsh-pre-restore-` | 上游自管 | ❌ |
| **OS 兜底** | fork | 每小时（Windows 任务，DSH 关闭也跑） | `os-` | 脚本自管（14） | ❌ 完全不可见 |

设计意图：

- `dsh-change-` 与 `dsh-baseline-` 故意做成「内部快照」——**不进用户列表、不参与主轮转、不被 latest 误选**，避免频繁改配置把定时备份挤掉。
- `os-` 前缀不以 `dsh-` 开头，上游的归档扫描完全看不见它，两套轮转互不干扰。
- **变更前状态**由「上一份快照」与「稳定基线」共同保证：任何一次变更发生时，手里一定有一份干净的变更前状态。

## 2. 变更监听细节

- 监听目标：`<dshHome>/profiles/**` 下扩展名为 `.json` / `.yml` / `.yaml` 的文件，外加 `<dshHome>/.credentials.yaml`。
- 忽略：`node_modules`、点开头目录（如 `.pnpm`）。
- 防抖：收到最后一个事件后静默 `debounceSeconds`（20s）才动手，避免 pnpm 连续写十几个文件触发多次。
- 去重：动手前重算配置指纹，与上次一致则跳过。
- 串行：通过上游 `enqueueHeavy` 排队，与定时备份、升级快照互斥，不会并行抢磁盘。
- 不监听 sessions/storages：它们每步都在写，纳入会形成快照风暴。

## 3. 失败与降级

- 任何异常只 `console.warn`，**不阻断宿主启动**。
- 系统任务：非 Windows 直接跳过并提示；同名任务若不属于本插件（Description 不以 `dsh-backup-os:` 开头）→ 拒绝接管（`conflict`）。
- 系统任务注册不需要管理员权限（跑在用户会话内）。
- 卸载时自动反注册（除非 `keepTaskOnUninstall: true`）。

## 4. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `destination` | `~/Desktop/DSH Backups` | 归档目录（本机已设为 `D:/dsh-backups`） |
| `keep` | 0 → 按规则 7/3 | 主归档保留份数（本机 10） |
| `exclude` | `[]` | 额外 tar 排除模式 |
| `redact` | 内置清单 | 凭据脱敏清单，`off` 关闭 |
| `githubRepo` / `updateCheck` / `gfsMonthly` / `gfsYearly` / `marketUrl` | — | 上游原有 |
| **`watchConfig`** | `false` | 配置变更触发（本机 true） |
| **`debounceSeconds`** | `20` | 变更静默期 |
| **`changeKeep`** | `10` | 变更快照保留份数 |
| **`stableBaselineMinutes`** | `30` | 连续多久无变更才刷新基线；0=关闭 |
| **`enableSystemTask`** | `false` | 装配 Windows 计划任务（本机 true） |
| **`keepTaskOnUninstall`** | `false` | 卸载时保留系统任务 |

## 5. 对上游默认行为的影响

- **开关全关（默认）**：零影响。fork 的代码块被两个布尔守卫包住，未启用时只多做一次配置读取。
- **开关打开**：
  - 新增两类内部快照，**不占用主轮转名额**（已用 `SNAPSHOT_PREFIXES` 隔离）；
  - 新增一个 Windows 计划任务与一份独立脚本，归档用 `os-` 前缀，**对上游不可见**；
  - 设置面板会多出 6 个控件（schema 派生，属预期）。
- 上游函数体**未被修改**；仅两处常量数组追加了元素（`SNAPSHOT_PREFIXES`、`SETTINGS_FIELDS`）。

## 6. 容量（本机实测口径）

- `.dsh` 实际 1.35 GB，其中用户数据仅约 11 MB；`dsh-ops`(412M)、`dsh-runtimes`(271M)、`node_modules`(631M) 均为可重建缓存。
- 本机配置已排除 `dsh-ops` 与 `dsh-runtimes`，单份归档预计从 **264 MB 降到约 15 MB**。
- 稳态估算：主 10 + 变更 10 + 基线 2 + OS 14 ≈ 36 份 × ~15 MB ≈ **540 MB**。

## 7. 恢复路径

1. `/backup restore latest --dry-run` 预览 → `/backup restore latest` 执行（恢复前自动再拍一份 `dsh-pre-restore-`）。
2. 内部快照可显式指名前缀恢复（如 `dsh-change-`、`dsh-pre-upgrade-`）。
3. DSH 起不来时：备份目录里的 `rescue.mjs` / 「点我恢复.bat」，零依赖。

## 8. 卸载

1. 从 profile 的 `dependencies` 与 `dsh.profile.bundles` 移除 `@xiaoyuyu6420/dsh-backup`；
2. `pnpm install`；
3. 插件 dispose 时反注册 `DSH Backup (OS layer)` 任务（除非 `keepTaskOnUninstall`）；
4. `D:/dsh-backups` 与内容不受影响，可手动删除。

## 9. 改动面（相对上游）

```
M lib/index.js      +97 行（SCHEMA/DEFAULTS/SETTINGS_FIELDS/normalizeField 追加 + apply 末尾接线块）
M package.json      版本改 0.14.2-fork.1；engines.dsh 与 6 个 peer 范围追加 ^0.2.1-rc.1
+ lib/trigger.js    配置变更监听（fs.watch + 防抖 + 指纹）
+ lib/system-task.js OS 计划任务装配 + 独立 tar 脚本生成
```

上游两处常量被追加元素：

- `SNAPSHOT_PREFIXES` 增加 `dsh-change-`、`dsh-baseline-`
- `SETTINGS_FIELDS` 增加 6 个 fork 字段

## 10. v2 变更：OS 层让位 + 三缺陷补齐

### 10.1 让位逻辑

OS 兜底脚本启动后先判断，**有成功备份就直接退出**：

1. 读 `DEST/auto.json` 的 `lastAutoAt`，距今 < `osMinIntervalHours`（默认 2h）→ 让位跳过；
2. 否则看自己上一份 `dsh-os-*` 归档的 mtime，同样不足阈值 → 跳过。

实测输出：`宿主内定时 0.3 小时前刚备份过，让位跳过`，退出码 0。

### 10.2 三个缺陷已补齐

| 缺陷 | 修法 | 实测 |
|---|---|---|
| 明文凭据进归档 | 脱敏清单含 `.credentials.yaml` / `.env` / `qq-bridge/config.json` / `undo-snapshots/auto/env-vault`，目录型模式同时排除目录与内容 | 归档内已无这些条目 |
| 缺校验边车 | 流式算 sha256 写 `<archive>.sha256` | 与 `sha256sum` 一致 |
| 缺 meta | 写 `<archive>.meta.json`（host/home/dshHome/createdAt/source） | 恢复预检可用 |

### 10.3 命名与可见性

- 归档名：`dsh-os-<yyyyMMdd-HHmmssSSS>.tar.gz`
- 已加入上游 `SNAPSHOT_PREFIXES` → **不进用户列表、不参与主轮转、不被 latest 误选**，但可用显式前缀 `dsh-os-` 恢复。
- 自有轮转只处理 `dsh-os-*`（含 .sha256 / .meta.json 一起删）。

### 10.4 发现的上游缺陷（已在本机规避）

上游的脱敏清单按**精确文件名**匹配（`.credentials.yaml`、`.env`），**漏掉了**
`undo-snapshots/auto/env-vault/<hash>.env` —— 那是 undo 插件保存的**明文凭据**，
会原样进入正式备份，进而可能被推送到 GitHub/WebDAV/S3。

本机已通过 `exclude` 配置排除该目录，对上游备份与 OS 兜底同时生效。
建议向上游报 issue。

### 10.5 容量实测

- 排除 `dsh-ops` / `dsh-runtimes` / env-vault 后：
  - OS 兜底归档 **15.9 MB**（改造前 264 MB）
  - 条目 239 个（profiles 配置 / sessions / storages / undo / undo-snapshots / mcp / @wingsky-1）


## 11. 可移植性：备份目录不再写死

- 声明式配置层（profile 的 `cordis.patch.yml`）里**不再包含 `destination`**。
- 插件代码内无任何机器相关路径；默认值是可移植的 `~/Desktop/DSH Backups`（上游默认）。
- 备份目录属于**用户设置**，在「设置 → 备份 → 设置」里配置，由宿主持久化到用户层。
- OS 兜底脚本的目录/保留份数在挂载时与每 10 分钟同步一次，用户在设置页改完无需重启即会跟随。

可移植的配置项（可以安全地写进声明式层）：
`keep` / `exclude` / `watchConfig` / `debounceSeconds` / `changeKeep` / `stableBaselineMinutes` / `osMinIntervalHours` / `enableSystemTask` / `keepTaskOnUninstall`。


## 12. 已知问题：OS 计划任务会弹控制台窗（2026-11-12）

任务计划器以交互用户身份启动 node.exe（控制台程序），每小时必然闪现一个窗口，
Hidden 设置不可靠（conhost 仍会创建）。**默认推荐：关闭 enableSystemTask，只用宿主内定时。**

若确需「DSH 关闭也备份」且能容忍弹窗（或用 wscript 隐藏包装器），再开启该开关。

## 13. 教训：destination 的落位要闭环（2026-11-02 → 11-12）

11-02 为可移植性把 destination 从 profile 条目移除、依赖用户在面板设置——但移除后
没有任何机器实际设置过它，下次重启后备份目录悄悄回落到包默认值（~/Desktop/...），
auto 状态跟着目录走变成未开启，造成 10 天无宿主备份（只有 OS 兜底在跑）。

正确分层（现已如此落地）：
- **包**：默认值保持可移植（~/Desktop/DSH Backups），不含机器路径；
- **每台机器的 profile 条目 config**（面板写的就是这个位置）：必须显式设置本机目录，
  装完插件的初始化清单里这是第一步；
- 面板设置项即持久层，改完热生效；备份状态（auto.json）与目录绑定，换目录等于换状态。

多机安装后务必检查：设置 → 备份 → 状态里的目录是否正确、auto 是否已开启。

## 14. 修复：wiring 作用域 ReferenceError 导致触发层从未启动（2026-11-12）

11-02 接线块引用了裸 `dshHome`，但该变量只存在于 `paths()` 函数体与 `doBackupInner`
内——apply 作用域中未定义。ReferenceError 被接线自己的 try/catch 吞掉（只写宿主
console），导致 **watcher 与 OS 装配自挂载起从未运行**。排查中一度把实际存在 10 天
的 OS 任务误认为插件装配成功——那其实是 11-02 手工 selftest 遗留未清理的任务。

教训：
- 接线代码引用的每个标识符都要在**挂载态**验证，模块级自测不能替代；
- 静默 catch 的降级日志要能在宿主日志里查到（宿主 console 不可见时形同没有）；
- 测试装配的系统任务必须在 selftest 末尾 dispose，或带一次性任务名。

修复：wiring 开头 `forkDshHome = paths().dshHome`，三处调用改用该值并以三元短路，
缺失时打日志跳过，不抛错。
