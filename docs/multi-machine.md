# 多机部署指南

这个 fork 的目标：**同一份包，装到任意一台机器上，行为一致、路径各自本地配置**。

## 0. 包标识（已确定）

```
name:    @denebwang/dsh-backup
version: 0.15.0-fork.1
repo:    https://github.com/denebwang/dsh-backup
```

`id: dsh-backup` 保持不变（只是条目标识）。

## 1. 三种分发方式

### A. GitHub（推荐）

```bash
# 一次性：推到自己的仓库
git remote add mine https://github.com/denebwang/dsh-backup.git
git push mine main

# 每台机器：
dsh plugin --profile desktop add github:denebwang/dsh-backup
# 重启 dsh
```

升级：`git push` 后在每台机器跑 `dsh plugin --profile desktop update @denebwang/dsh-backup`，重启生效。

### B. npm 私有/公开 scope

```bash
npm publish --access public
dsh plugin --profile desktop add @denebwang/dsh-backup
```

### C. 离线 tarball（内网）

```bash
pnpm pack                      # 产出 dsh-backup-x.y.z.tgz
# 拷到目标机，然后：
dsh plugin --profile desktop add file:D:/path/to/dsh-backup-x.y.z.tgz
```

## 2. 每台机器的初始化清单

| 步骤 | 说明 |
|---|---|
| 1. 装插件并重启 | 见上 |
| 2. 打开 设置 → 备份 | 面板应出现（独立分区） |
| 3. 设置备份目录 | **每台机器各自设**，推荐非系统盘，例如 `D:\dsh-backups` 或 `~/dsh-backups` |
| 4. 确认 OS 兜底 | Windows：任务计划里出现 `DSH Backup (OS layer)`；macOS/Linux：按日志里的 crontab/systemd 指引挂一次 |
| 5. 跑一次手动备份 | 面板「立即备份」，确认体积与校验 |

## 3. 跨机器差异（刻意设计）

- **备份目录**：用户设置，不写进包；不随 profile 分发。
- **调度方式**：Windows 用任务计划器；macOS/Linux 需手动挂 cron/systemd（插件会把命令打出来）。
- **node 位置**：自动从 PATH 探测，也可用 `DSH_BACKUP_NODE` 环境变量指定。
- **其余配置**（keep / exclude / watchConfig / changeKeep / stableBaselineMinutes / osMinIntervalHours / enableSystemTask / keepTaskOnUninstall）都可以安全地写进声明式层，随 profile 分发。

## 4. 升级上游

本 fork 的改动面固定在：

```
M lib/index.js      （SCHEMA/DEFAULTS/SETTINGS_FIELDS/normalizeField 追加 + apply 末尾接线块）
M lib/client.js     （settings.plugins.tab → settings.section，2 处字符串）
M package.json       （名称/版本/engines+peers 范围）
+ lib/trigger.js, lib/system-task.js, lib/os-fallback.mjs
```

```bash
git remote add upstream https://github.com/xiaoyuyu6420/dsh-backup.git
git fetch upstream
git rebase upstream/main     # 冲突预期只有上面两处常量数组 + 末尾接线块
```

## 5. 回滚

- 配置层：`undo_restore` 回插件安装前的快照。
- 插件本体：从 profile 的 `dependencies` 与 `dsh.profile.bundles` 移除，`pnpm install`，重启。
- 数据：`/backup restore latest --dry-run` 预览后再执行。
