[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# pi-codex-memory

一个独立的 pi 扩展，移植了 [OpenAI Codex](https://github.com/openai/codex/tree/5bf132cd527311eb61bbec46562e3890eb49df80/codex-rs/memories) 的记忆行为，固定在提交 `5bf132cd527311eb61bbec46562e3890eb49df80`。直接使用 pi 的会话、模型注册表和认证；不需要安装 Codex 或拥有其账号。与宿主的差异及验证情况见 [CODEX_PARITY.md](CODEX_PARITY.md)。

## 安装

需要 Node >=22.13、pi >=0.85.1 和 Git。

用 pi 安装已发布的扩展：

```sh
pi install npm:pi-codex-memory
```

重启 pi 或在现有会话中执行 `/reload`，然后用 `/memories status` 检查扩展。默认使用当前 pi 会话模型，无需单独配置模型。

更新已有的 npm 安装：

```sh
pi update npm:pi-codex-memory
```

更新后重新加载 pi。本地开发时用 `pi install /path/to/pi-codex-memory` 安装检出目录。固定的 Codex 上游源码不会在运行时自动更新。

## 行为

- 符合条件的持久根会话在第一个用户轮次派发后台流水线。临时会话和子代理会话被排除。
- 阶段 1 选择最近空闲的交互会话，认领 SQLite 作业，清理活动分支，请求结构化抽取并存储经过验证的结果。租约、有界并发和重试退避防止重复工作。
- 阶段 2 每个记忆版本认领一个全局作业，按使用量/新近度选择证据，同步 rollout 摘要和 V1 原始记忆，清理资源，并计算 Git 工作区 diff。没有变更且产物有效时，不会调用整合模型。
- 存在变更时，一个隔离的 pi SDK 代理会话通过受限（jail）的文件工具整合记忆。不加载通用扩展、项目指令、shell/网络工具和递归委派。SDK 压缩与取消使用同一 pi 模型/认证路径。这是工具级隔离，不是 Codex 的操作系统沙箱。
- 读取路径注入上游指令和有界的记忆摘要。被引用的 rollout ID 会更新使用计数。专用检索/笔记工具是可选的，遵循固定的契约。
- V1 和 V2 使用各自独立的根目录/数据库。双写会独立派发两条流水线。就绪状态报告 V2 阈值和摘要有效性，但不会改变活动版本。

没有单独的高效配置、FTS/向量索引、QMD 模型、语义检索、自定义核心快照或每日增量蒸馏预算。

## 配置

保存在 `~/.pi/agent/memories.json`：

```json
{
  "version": "v1",
  "dual_write": false,
  "enabled": true,
  "generate_memories": true,
  "use_memories": true,
  "dedicated_tools": false,
  "disable_on_external_context": false,
  "max_raw_memories_for_consolidation": 256,
  "max_unused_days": 30,
  "max_rollout_age_days": 10,
  "max_rollouts_per_startup": 2,
  "min_rollout_idle_hours": 6,
  "extract_model": null,
  "consolidation_model": null,
  "tool_result_token_budget": 1000,
  "extract_thinking": "low",
  "consolidation_thinking": "medium"
}
```

### 降低后台 token 成本

阶段 1 会重新读取整个 rollout，而在真实会话中约 70% 的 rollout 是工具输出（文件读取、命令 stdout）。有两个无依赖的手段：

1. **更便宜的模型** — `extract_model` / `consolidation_model`（见上）。这是迄今最大的节省。
2. **`tool_result_token_budget`**（宿主新增，Codex 中没有；默认 `1000`，`0` 表示禁用）— 抽取前，每个工具结果被限制在这个 token 数内，保留头尾（错误保留 3 倍），相同行的连续重复折叠为 `[… same line ×N]`，完全相同的重复结果替换为 `[identical to tool result #N: <首行>]`（工具行编号为 `[tool name #N]`）。用户和助手的文本从不被修改，因此抽取器能看到完整对话，而不是因为一次大文件转储而丢失对话尾部。

在不调用任何模型的情况下用自己的会话测量：

```bash
node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
```

本地机器示例（5 个会话，渲染 745K token，当时 OpenRouter 标价）：

| | 渲染的 rollout | 发送到阶段 1（150K 上限） | 阶段 1 成本 |
|---|---|---|---|
| 会话模型（`gpt-6-astra` / `claude-fable-5.1`，$10/$50 per M），原始 | 745K | 321K | $3.58 |
| 同一模型，budget 1000 | 485K (-35%) | 275K (-14%) | $3.12 |
| `deepseek/deepseek-v4.1-flash`（$0.30/$1.20 per M），原始 | 745K | 321K | $0.105 |
| flash，budget 1000 | 485K | 275K | **$0.092（便宜 ×39）** |

Budget 500 以缩短非错误工具输出为代价，把渲染的 rollout 减少约 47%。已经超过 150K 上限的会话不会更便宜——只会得到更均衡的输入。设置 `BENCH_PRICES='{"name":{"in":..,"out":..}}'` 可比较其他模型。

**压缩能省什么、不能省什么。** 节省受 rollout 中工具输出占比限制：`≈ tool_share × (1 − 1/compression)`，压缩后仍超过 150K 上限的会话为零。以文件读取和命令输出为主的会话（通常工具输出占 70–90%）可节省 30–60%；以助手代码和粘贴文本为主，或工具输出已被实时压缩（例如 `rtk` 类 shell 过滤器）的会话几乎没有节省。这是预期之中的：实时过滤器在源头一次性砍掉相同的字节，而阶段 1 只读取每个 rollout 一次，所以没有每轮的倍增效应来放大收益。

端到端检查（`scripts/bench-pipeline.sh`，在隔离的 home 中运行真实的阶段 1 + 阶段 2，认领相同的两个会话，`gpt-6-astra`，thinking low）：budget 0 → 阶段 1 223K token，阶段 2 42K 输入 / 132K 缓存 / 5.3K 输出；budget 1000 → 阶段 1 225K，阶段 2 31K / 164K / 6.0K。阶段 1 没有节省，因为大会话只有 10% 工具输出且仍高于上限。模型选择才是主导：同样的运行在 `deepseek-v4.1-flash` 上便宜约 11 倍（thinking `max`）到 30–40 倍（thinking `low`）。

```bash
# 真实模型调用，会产生费用；label extract_model consolidation_model extract_thinking consolidation_thinking budget [会话用 provider/model]
scripts/bench-pipeline.sh G1 null null low low 1000 openai-codex/gpt-6-astra
```

每次流水线运行都会在 `memories.log` 追加 `phase1: … N tokens` 和 `phase2: usage requests=… input=… cacheRead=… output=…`，正常使用后即可查看自己的数字。

模型采用 `provider/model-id` 形式。默认两个阶段都使用当前 pi 会话模型（`null`）；显式设置只覆盖对应阶段。不会自动选择 Codex 偏好的模型。显式设置若不可用或未认证会失败；请求错误绝不会触发模型切换。`/memories status` 显示最后选择的 provider/model、`session-default` 或 `explicit`，以及抽取输出的强制方式。

### 选择记忆模型

**建议为后台记忆抽取与整合显式选择一个低成本模型**，尤其当交互会话使用昂贵模型时。这些阶段和 SDK 压缩会产生额外的模型请求。选择能可靠生成所需 JSON 并能操作整合文件工具的模型，在依赖它之前检查其结果。

1. 在 pi 中配置并认证提供商，然后从 pi 的模型选择器复制准确的 `provider/model-id`。
2. 编辑 `~/.pi/agent/memories.json`（Windows：`%USERPROFILE%\.pi\agent\memories.json`），设置下面的一个或两个字段。把占位值替换为已注册的模型 ID；两个阶段可以使用同一模型。

```json
{
  "extract_model": "your-provider/your-lower-cost-model-id",
  "consolidation_model": "your-provider/your-lower-cost-model-id"
}
```

3. 重新加载 pi，下一次记忆运行后用 `/memories status` 确认所选模型和验证模式。

把任一字段设回 `null` 即可让该阶段使用当前会话模型。升级时现有显式设置保持不变。模型选择是 pi 宿主的适配；固定的 Codex 记忆处理规则不变。

经验证的 OpenAI Responses 和 Chat Completions 请求携带上游的 strict JSON Schema。其他提供商使用本地 schema 验证，并报告为兼容模式。所有输出都在本地验证。整合在正常的 SDK 助手停止加产物验证后完成；没有自定义完成工具或轮次上限。未实现 Codex 账号配额 API。

`generate_memories: false` 排除新会话；与上游一样，更早的符合条件的会话仍可能被处理。`use_memories: false` 禁用摘要注入和工具执行。`enabled: false` 禁用并取消本进程的流水线。版本和工具注册的变更需要重新加载。

## 命令与工具

`/memories [status|readiness [minimum]|run|force|on|off|generate on|off|use on|off|thread on|off|reset]`

`run` 遵守冷却时间；`force` 是显式的 pi 覆盖，即使在冷却/无变更时也运行。`thread off` 排除该会话并删除其抽取结果。Reset 需要确认，且在有运行中作业时拒绝执行。Reset 绝不会删除原始 pi 会话文件。

当 `dedicated_tools: true`、`enabled: true` 且 `use_memories: true` 时：

| 工具 | 契约 |
|---|---|
| `memories_list` | 可见的记忆文件；默认/最多 2,000 条 |
| `memories_search` | 结构化匹配、窗口与分页；默认/最多 200 条匹配 |
| `memories_read` | UTF-8 文件，行偏移与限制；默认 20,000 参考 token |
| `memories_add_ad_hoc_note` | 供后续整合使用的显式带时间戳笔记 |

摘要注入遵循上游 2,500 token 预算。搜索不会调用嵌入模型。

## 数据与迁移

V1：`~/.pi/agent/memories/`、`memories_1.sqlite`。V2：`memories_v2/`、`memories_2.sqlite`。产物包括 `memory_summary.md`、rollout 摘要、技能、扩展以及（V1）`MEMORY.md` / `raw_memories.md`。

会话启动时，已废弃的 profile/recall/core/tidy 设置和 `consolidation_max_turns` 会在把原配置备份为 `memories.json.before-codex-only.bak`（已存在则加数字后缀）后被移除。会发出一次迁移通知。提供商选择和其他设置保持不变。旧版 schema/状态标签在 SQLite 快照备份 `*.before-codex-schema.bak` 后升级；旧的 `failed` 作业变为上游的 `error` 作业。现有实验表保持不动且不使用。已下载的实验模型缓存不会自动删除。

抽取把历史会话内容发送给配置的 pi 提供商；整合通过同一提供商接口发送所选记忆产物。敏感信息脱敏是尽力而为。SDK 压缩可能产生额外的提供商请求。不承诺对付费提供商做过实时验证。

## 验证

`npm run check` · `npm test` · `git diff --check` · `npm pack --dry-run --json --ignore-scripts`

测试使用临时状态、固定模型响应、真实 pi SDK 会话（65 个工具轮次、取消、溢出压缩与恢复）、本地 HTTP 载荷捕获、并发进程以及已安装包的冒烟测试。上游测试向量原文覆盖过滤、截断、引用和资格判定。源码/提示哈希把测试绑定到固定提交。覆盖范围和宿主限制见 parity 矩阵。

隔离覆盖：`PI_CODEX_MEMORY_HOME`、`PI_CODEX_MEMORY_SESSIONS`。`PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1` 在无头冒烟运行中等待进行中的工作完成。

## 许可证

自有实现为 MIT；内嵌的 Codex 源码/模板为 Apache-2.0。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
