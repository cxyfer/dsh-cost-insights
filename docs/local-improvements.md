# 本地修改与维护

此分支在 `1.0.1` 的基础上整理本地修补，当前版本为 `1.0.1-dsh02.5`。运行中的
DSH profile 需要重新安装本版本后才会生效；clone、提交或修改源码不会变更启动程序、
profile 配置或账本。

从本仓库构建或取得 `dsh-cost-insights-1.0.1-dsh02.5.tgz` 后，安装到对应 profile：

```console
dsh plugin --profile web add ./dsh-cost-insights-1.0.1-dsh02.5.tgz
```

安装后重启 DSH。已有账本仍保存在 `storages/usage-insights/ledger.sqlite`，升级不会
迁移或删除历史数据。

## 1.0.1-dsh02.5 定价与回补

- 内置 `cline-pass/deepseek-v4.1-flash-1017` 定价：USD 0.30/百万输入、
  0.006/百万缓存命中、0.30/百万缓存写入、1.20/百万输出；Cline Pass 以 flat
  峰值价记录，来源为公开的 1017 价格页。
- 新增 `scripts/backfill-usage.mjs`。它默认只做 dry-run，加上 `--apply` 才会写账本；
  可以从本地 session JSONL 补齐未入账调用，也可以重算 `priced=0` 的旧记录：

  ```console
  # 先预览
  node scripts/backfill-usage.mjs --since 2026-10-21T00:00:00+08:00

  # 补齐日志并重算未定价记录
  node scripts/backfill-usage.mjs --logs --reprice --apply --since 2026-10-21T00:00:00+08:00
  ```

  脚本只读取 `DSH_HOME/storages/usage-insights/ledger.sqlite` 与
  `DSH_HOME/sessions`，不读取提示词、回复正文或凭据，也不会联网；读取压缩
  session 日志需要系统的 `zstd` 指令。可用 `--session`、`--model` 缩小范围。
  写入前建议先备份 ledger。

## 1.0.1-dsh02.4 兼容性修正

- DSH 兼容范围由 `>=0.1.0-rc.7 <0.2.0 || 0.2.0-rc.2` 放宽为
  `>=0.1.0-rc.7 <0.3.0-0`，覆盖 `0.2.1-rc.2` 及后续 0.2.x 版本，同时排除
  0.3 预览版。`engines.dsh` 是 DSH 启动时的唯一判定来源，
  `dshhub.compatibility.dsh` 与 peer 依赖保持同一范围。
- DSH 0.2.1 将设置入口从 `aria-haspopup="dialog"` 改为账号菜单。侧栏“今日费用”
  现在先尝试旧版对话框入口，再回退到账号菜单，继续打开“设置 → 用量与费用”。
- 移除 0.2.x 已不再提供的 `@deepseek-ai/dsh-client-runtime` 客户端注入项。
- 版本与兼容范围检查改为跟随 `package.json`，并校验 `engines.dsh`、dshhub 元数据、
  peer 依赖与 Node engine 是否一致，避免下次更新时因硬编码再次失配。

## 保留的功能修补

- Host 与 browser 的 Typert strict codec 改用 `create()`，保留原本的参数与结果 schema。
- 缓存命中单独显示 Token 与费用；既有 `inputCost*` 仍包含缓存读取费，未命中输入费由界面相减取得。总费用与原始调用不改写。
- Token 总计包含输入、缓存读取、缓存写入及输出；推理已包含在输出，不重复累加。
- 今日／本月／全部卡片可点击；本日／近 7 天／近 30 天与日期下拉菜单共用状态。近 7／30 天包含本日，从当地午夜起算；快速切换只采用最后一次请求的响应。

## 验证范围

- 发布元数据、版本一致性、可移植性与敏感信息检查。
- Node.js 语法检查与现有单元测试。
- 在独立临时 `DSH_HOME` 中安装本版本，使用 DSH `0.2.1-rc.2` 启动 Web 界面，
  验证 host 无兼容跳过警告、设置页可打开、侧栏“今日费用”可直接进入
  “设置 → 用量与费用”，且浏览器控制台无错误。
- 回补脚本先在 ledger 副本上执行 `--apply`，确认插入数、重算数、无重复记录与
  幂等性，再对实际 ledger 执行；执行前另存完整备份。
