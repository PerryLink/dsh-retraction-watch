# dsh-retraction-watch

**你引用的论文，后来有没有被撤稿或更正？**

*Crossref 工作记录 + 已实测的 `filter=updates:<doi>` 查询、逐 DOI 状态、可见变化的追加式时间线，以及可复读的 REP 证据。`clear` 只表示没有登记在册的通知，绝不是“这篇论文没问题”。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- `retraction_check(doi)` → `retracted` / `concern` / `corrected` / `notice` / `clear` / `unknown`，并附通知 DOI，以及一条包含两次 Crossref 响应的 REP 证据记录。
- `retraction_watch(dois)` → 对一份参考文献列表做同样的检查，并**检测变化**：时间线记录每一次观察到的状态，因此“clear → retracted”会作为变化报出。
- `retraction_report(items)` → Markdown 表格 + SARIF 2.1.0（撤稿/关注 = error，更正 = warning）。

## 已验证的数据源能力（不是猜的）

| 查询 | 结果 |
|---|---|
| `GET /works/{doi}` | 被引用的工作；若其中带有 `update-to`，说明这个 DOI 本身就是一条通知 |
| `GET /works?filter=updates:{doi}` | 更新该 DOI 的工作 —— **实测可用，HTTP 200**（2026-11-08） |
| `GET /works?filter=update-to:{doi}` | **不存在**，HTTP 400 |
| `filter=relation.type:is-retracted-by` | **不是合法的 relation type**，HTTP 400 |

插件只使用这两条可用的查询。更新查询失败时，报告 `unknown` 和一项 `skipped` 检查 —— 绝不会报 `clear`。

## 状态含义

| 状态 | 含义 |
|---|---|
| `retracted` | 有撤稿通知指向该 DOI |
| `concern` | 有关注声明指向它 |
| `corrected` | 有更正通知指向它 |
| `notice` | 有其他类型的更新通知指向它 |
| `clear` | Crossref **没有登记**更新通知 |
| `unknown` | DOI 不在 Crossref，或查询失败 |

`clear` 表示“没有证据”，而不是“证据表明有效”：Crossref 通知可能滞后于发表，而且 v0.1 **不查询** Retraction Watch 的覆盖范围。`unknown` 永远不会被并入 `clear`。

## 它不做什么

- **不接入 Retraction Watch**（接入前需先核对许可与覆盖范围）。
- **不做质量判断**：有更正不代表论文有错，撤稿理由也不作评估。
- **不做抓取**：除这两条 Crossref 查询外不再抓取其他内容；不碰 CNKI，也不碰 Sci-Hub。
- **不做定时运行**：每次调用工具时才更新时间线；调度由宿主（`dsh-jobs`）或用户负责。

## 兼容性与安装

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer 依赖 | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-retraction-watch
dsh --profile <name> --dump-config | grep dsh-retraction-watch
```

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载任何内容 |
| `root` | `.retraction-watch` | 存储、缓存、时间线与记录的根目录 |
| `userAgent` | `dsh-retraction-watch/0.1.0 (…)` | 发送给 Crossref |
| `mailto` | — | Crossref polite pool 联系方式（可选） |
| `timeoutMs` | `15000` | 单次请求的超时 |
| `minIntervalMs` | `150` | 同一 host 的最小间隔 |
| `retries` / `maxRedirects` | `1` / `3` | 有界的重试与重定向预算 |
| `cacheTtlMs` | `604800000` | 响应缓存（7 天；`fresh` 绕过） |
| `maxBatch` / `batchConcurrency` | `50` / `3` | `retraction_watch` 的上限 |

## 安全边界

- 仅使用 HTTPS，采用精确 host 白名单（`api.crossref.org`），URL 中不带凭据，不使用自定义端口。
- 重定向手动跟随，**每一跳都会重新校验**是否在白名单内。
- 响应以不可变快照形式存储；证据只记录 URL，绝不记录密钥。
- 缓存响应是尽力而为：缓存失败只算未命中，绝不作为检查结果。

## 评测

**23 个测试**，分布在三个文件：更新类型映射、通知过滤、聚合状态优先级、检查构造（clear / retracted / unknown / 网络失败）、运行时（撤稿、带保留说明的 clear、404 → unknown、更新查询失败 → unknown、更正、非法 DOI、重复核查不产生证据冲突、瞬时 5xx 不写入缓存、polite pool 联系方式不写入已存证据）、跨三次运行的时间线变化检测（首次观察不算变化）、批量逐项隔离、批量上限、工具 schema/渲染器、包契约。

人工样例集（本插件不声称基准测试结果；其正确性来自 Crossref 契约，而不是学习得到的判定）：

| 场景 | 预期 | 覆盖 |
|---|---|---|
| 有撤稿通知指向该 DOI | `retracted`，检查 `fail` | 测试 |
| 有更正通知 | `corrected`，检查 `warn` | 测试 |
| 有关注声明 | `concern`，检查 `fail` | 测试 |
| 无通知 | `clear` + 无通知说明 | 测试 |
| DOI 不在 Crossref | `unknown`，`not_found` skipped | 测试 |
| 更新查询 5xx | `unknown`，`network_error` skipped | 测试 |
| 两次运行之间状态变化 | `changed: true`、`previousStatus` | 测试 |
| 首次观察某个 DOI | `changed: false`，无 `previousStatus` | 测试 |

## 已知限制（v0.1）

- 不查询 Retraction Watch 数据，仅覆盖 Crossref。
- 没有 Crossref `update-to` 链接的通知在此不可见。
- 时间线是追加式 JSONL，不做压缩合并；书目很大时需手工裁剪。
- 没有邮件/webhook 告警；轮询必须由调用方驱动。

## 许可

Apache-2.0。运行时不含第三方代码。
