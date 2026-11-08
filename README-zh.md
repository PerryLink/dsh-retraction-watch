# dsh-retraction-watch

**你引用的论文，后来有没有被撤稿或更正？**

*Crossref 工作记录 + 已实测的 `filter=updates:<doi>` 查询、逐 DOI 状态、可见变化的追加式时间线，以及可复读的 REP 证据。`clear` 只表示“没有登记在册的通知”，绝不是“这篇论文没问题”。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- `retraction_check(doi)` → `retracted` / `concern` / `corrected` / `notice` / `clear` / `unknown`，附通知 DOI 与包含两份 Crossref 响应的 REP 证据记录。
- `retraction_watch(dois)` → 对一批文献做同样检查，并**检测变化**：时间线记录每次观察到的状态，因此 “clear → retracted” 会作为变化报出。
- `retraction_report(items)` → Markdown 表 + SARIF 2.1.0（撤稿/关注 = error，更正 = warning）。

## 已实测的数据源能力（不是猜的）

| 查询 | 结果 |
|---|---|
| `GET /works/{doi}` | 被引工作本身；若它带 `update-to`，说明该 DOI 本身就是通知 |
| `GET /works?filter=updates:{doi}` | 指向该 DOI 的更新/撤稿通知 —— **实测 HTTP 200**（2026-11-08） |
| `GET /works?filter=update-to:{doi}` | **不存在**，HTTP 400 |
| `filter=relation.type:is-retracted-by` | **不是合法 relation type**，HTTP 400 |

插件只用两条可用的查询。更新查询失败时报 `unknown` + `skipped` 检查——绝不会报 `clear`。

## 状态含义

| 状态 | 含义 |
|---|---|
| `retracted` | 有撤稿通知指向该 DOI |
| `concern` | 有关注声明指向它 |
| `corrected` | 有更正通知指向它 |
| `notice` | 有其他类型的更新通知指向它 |
| `clear` | Crossref **没有登记**更新通知 |
| `unknown` | DOI 不在 Crossref，或查询失败 |

`clear` 是“没有证据”，不是“证据表明没问题”：Crossref 通知可能滞后，且 v0.1 **不查询** Retraction Watch。`unknown` 永远不会被并进 `clear`。

## 它不做什么

- **不接入 Retraction Watch**（许可与覆盖范围需先核对）。
- **不做质量判断**：更正不等于论文错，撤稿原因也不评估。
- **不爬站**：只用两条 Crossref 查询；不碰 CNKI、不碰 Sci-Hub。
- **不做定时任务**：调用时才更新时间线；调度交给宿主（`dsh-jobs`）或用户。

## 兼容性与安装

| 项 | 值 |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-retraction-watch
dsh --profile <name> --dump-config | grep dsh-retraction-watch
```

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 不挂载 |
| `root` | `.retraction-watch` | 存储、缓存、时间线与记录根 |
| `userAgent` | `dsh-retraction-watch/0.1.0 (…)` | 发给 Crossref |
| `mailto` | — | Crossref polite pool 联系方式（可选） |
| `timeoutMs` | `15000` | 单请求超时 |
| `minIntervalMs` | `150` | 同 host 间隔 |
| `retries` / `maxRedirects` | `1` / `3` | 有界重试与重定向预算 |
| `cacheTtlMs` | `604800000` | 响应缓存（7 天；`fresh` 绕过） |
| `maxBatch` / `batchConcurrency` | `50` / `3` | `retraction_watch` 边界 |

## 安全边界

- 仅 HTTPS、精确 host 白名单（`api.crossref.org`）、URL 无凭据、无自定义端口。
- 重定向手动跟随，**每一跳重新校验**白名单。
- 响应落为不可变快照；证据只记录 URL，不记录密钥。
- 缓存是 best-effort：缓存失败只是未命中，不影响结论。

## 评测

**20 个测试 / 2 个文件**：更新类型映射、通知过滤、状态优先级、检查构造（clear / retracted / unknown / 网络失败）、运行时（撤稿、带缺口的 clear、404→unknown、更新查询失败→unknown、更正、非法 DOI）、三次运行之间的时间线变化检测、批量逐项失败隔离、批量上限、工具 schema/渲染、包契约。

人工样例集（本插件不声称 benchmark；其正确性来自 Crossref 契约，而不是学习出来的判定）：

| 场景 | 期望 | 覆盖 |
|---|---|---|
| 有撤稿通知指向该 DOI | `retracted`，检查 `fail` | 测试 |
| 有更正通知 | `corrected`，检查 `warn` | 测试 |
| 有关注声明 | `concern`，检查 `fail` | 测试 |
| 无通知 | `clear` + 缺口声明 | 测试 |
| DOI 不在 Crossref | `unknown`，`not_found` skipped | 测试 |
| 更新查询 5xx | `unknown`，`network_error` skipped | 测试 |
| 两次运行间状态变化 | `changed: true`、`previousStatus` | 测试 |

## 已知限制（v0.1）

- 不查 Retraction Watch，仅 Crossref 覆盖。
- 没有 Crossref `update-to` 链接的通知在此不可见。
- 时间线是追加式 JSONL，无压缩；超大书目需手工清理。
- 无邮件/webhook 告警；轮询需调用方驱动。

## 许可

Apache-2.0。运行时零第三方代码。
