# 更新日志

## 1.0.1-dsh02.5 - 2026-10-21

- 内置 `cline-pass/deepseek-v4.1-flash-1017` 定价：USD 0.30/百万输入、0.006/百万缓存命中、0.30/百万缓存写入、1.20/百万输出（官方 1017 峰值价，Cline Pass 以 flat 计价）。
- 新增 `scripts/backfill-usage.mjs`：可从本地 DSH session JSONL 补齐未入账调用，并按当前价格簿重算未定价记录；默认 dry-run，只有 `--apply` 才写入。
- 回补脚本只读取本地 ledger 与 session transcript，不读取提示词、回复正文或凭据，也不会联网。

## 1.0.1-dsh02.4 - 2026-10-21

- 放宽 DSH 兼容范围为 `>=0.1.0-rc.7 <0.3.0-0`，覆盖 DSH `0.2.1-rc.2` 及后续 0.2.x 版本；`engines.dsh`、`dshhub.compatibility.dsh` 与 peer 依赖共用同一范围。
- 适配 DSH `0.2.1-rc.2` 的账号菜单式设置入口：点击侧栏“今日费用”可直接打开“设置 → 用量与费用”，同时保留旧版对话框入口。
- 移除 0.2.x 已不再提供的 `@deepseek-ai/dsh-client-runtime` 客户端注入项。
- 版本检查改为跟随 `package.json`，并校验 DSH 与 Node 兼容范围在各处元数据中保持一致。

## 1.0.1-dsh02.3 - 2026-10-18

- 修正 host 与 browser 的 Typert strict codec，支持 DSH `0.2.0-rc.2`。
- Token 与费用图表分别显示未命中输入、缓存命中、缓存写入与输出，并将缓存 Token 纳入侧栏、热力图及 CSV。
- 今日／本月／全部卡片可点击，新增本日／近 7 天／近 30 天快捷切换，日期由当地午夜起算。

## 1.0.1 - 2026-08-22

- 将项目、仓库和插件标识从 `dsh-usage-insights` 更名为 `dsh-cost-insights`，避免与现有插件重名。
- 保留 `storages/usage-insights/ledger.sqlite` 数据路径，确保历史账本继续可用。
- 更新发布工作流，使后续语义化版本标签均可生成 GitHub Release。

## 1.0.0 - 2026-08-22

首个正式版本。

- 支持按对话、工作区、模型、API 提供商、连接、用途和日期范围统计用量。
- 新增 Token 与费用变化、使用分布、365 天热力图、API 余额和模型价格同步。
- 支持汇率换算，以及 DeepSeek 官方调用的高峰价和低谷价。
- 在不替换原界面的前提下扩展 DSH 对话统计栏与侧边栏。
- 自动跟随 DSH 的中文/英文语言和浅色/深色主题。
- 使用本地 SQLite 记录可审计的数值数据，不保存提示词、回复正文或 API Key。
- 在“更多 → 关于”中连续点击版本号 7 次可导出脱敏诊断日志。
