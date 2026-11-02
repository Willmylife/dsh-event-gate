# dsh-event-gate

事件驱动触发器（"门铃"）：**文件变化 / 本地 webhook 命中规则后，唤醒指定 DSH 会话并注入 prompt。**
补上 [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)（"闹钟"：按时间自我唤醒）之外的另一半——**由外部世界叫醒**。

## 能干什么（典型场景）

- **下载目录自动整理**：监视下载文件夹，新文件出现就让会话按你的规则归档、改名、写摘要
- **报警自动诊断**：CI 或监控脚本 POST 一条消息到本机 webhook，会话立刻分析失败原因并给出修复建议
- **日志哨兵**：监视日志目录，出现 ERROR 就让会话读上下文、定位问题、动手修
- **让本机任何程序指挥 DSH**：一条 curl 就能在自己的脚本、打包流程、快捷指令结束时让会话接着干下一步

机制一句话：规则文件里写清"听什么动静、叫醒谁、醒了干什么"，插件负责在事件命中的那一刻把"发生了什么"作为消息注入那个会话——会话开着直接投递，关着先恢复再投递；每次触发都有审计记录，`trigger_history` 随时可查。

## 已实现（当前源码）

- **fs 事件源**：递归监视目录，按规则防抖合并（`{{paths}}` 带合并后的文件列表），glob 过滤；`maxWaitMs` 防止持续写入无限推迟
- **webhook 事件源**：`POST /__dsh-event-gate/hook`，按规则 token 鉴权，回环限定；token 仅通过请求头或 JSON body 传递
- **唤醒**：活会话直接投递；冷会话 `agents.resume` 恢复后投递（恢复模型选择与预设，尽力而为）
- **可靠调度**：同一目标会话串行恢复和投递；fs 等待期间按规则合并，webhook 使用有界 FIFO；busy 自动退避重试
- **规则热更新**：编辑 `rules.json` 保存即生效，无需重启 DSH；同 ID 的 fs 配置变化也会重建 watcher
- **可观测性**：`trigger_list`（token 已脱敏）/ `trigger_history` 工具 + `/health` 路由 + 串行写入、原子裁剪的 JSONL 触发历史

## 安装

- **插件市场**（收录后）：DSH 设置 → 插件 → 添加插件，搜索 `dsh-event-gate`
- **命令行**：`dsh plugin --profile web add github:Willmylife/dsh-event-gate#v0.3.0`（桌面端请用应用内"添加插件"）
- **本地开发**：见下方 link 方式

## 配置

规则文件：`~/.dsh/event-gate/rules.json`（JSON 数组；模板见仓库 `rules.example.json`）。

```jsonc
[
  {
    "id": "watch-downloads-pdf",
    "source": "fs",                    // "fs" 或 "webhook"
    "enabled": true,
    "watch": "C:/Users/86188/Downloads", // fs：要监视的目录
    "filter": "**/*.pdf",              // fs：可选 glob 过滤
    "debounceMs": 3000,                // fs：静默防抖窗口
    "maxWaitMs": 30000,                // fs：持续事件下最长等待时间
    "targetSessionId": "<会话 id>",     // 要唤醒的会话
    "promptTemplate": "新文件：{{paths}}\n请检查。"
  },
  {
    "id": "ci-alarm",
    "source": "webhook",
    "enabled": true,
    "token": "至少 8 字符的随机口令",
    "targetSessionId": "<会话 id>",
    "promptTemplate": "收到消息：{{payload}}\n请分析。"
  }
]
```

**模板变量**：`{{ruleId}}`、`{{source}}`。

- fs：`{{count}}`（累计事件数）、`{{paths}}`（最多显示 50 条）、`{{pathsOmitted}}`、`{{pathsTruncated}}`。
- webhook：`{{payload}}`（JSON，token 已剥离）、`{{payloadTruncated}}`、`{{payloadOriginalLength}}`。超长 payload 会变为包含 `truncated`、`originalLength` 和 `preview` 的有效 JSON，而不是直接截断成半个 JSON 字符串。

**队列语义**：同一目标会话的等待队列最多容纳 100 个任务。fs 等待任务会按规则合并；webhook 每条事件单独排队。队列满返回 HTTP 429，宿主不可用返回 503；HTTP 202 表示已进入**内存队列**，不代表模型已经处理完成。DSH 重启会清空等待队列。

**webhook 调用**（本机）：

```bash
curl -X POST "http://127.0.0.1:<端口>/__dsh-event-gate/hook" \
  -H "content-type: application/json" \
  -H "x-event-gate-token: <你的token>" \
  -d '{"rule":"ci-alarm","message":"main 分支构建失败"}'
```

**拿会话 id**：会话 URL 或侧栏里复制；或问模型"这个会话的 id 是什么"。

## 开发安装（桌面端，link 方式）

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:"<本仓库绝对路径>"
# 并把 "dsh-event-gate" 加入 package.json 的 dsh.profile.bundles
```

重启 DSH 桌面端后，访问 `http://127.0.0.1:<端口>/__dsh-event-gate/health` 应返回
`{"ok":true,"plugin":"dsh-event-gate",...}`；设置页插件列表应出现本插件。

## 技术要点（来自 dsh-proactive v0.3.2 的逆向结论）

- 唤醒走宿主进程内 cordis 服务 `agents`（`@deepseek-ai/dsh-agent`）：冷会话
  `agents.resume({resumeSessionId, agentOptions, setup})` → `{agent, dispose()}`，句柄用完必 dispose。
- prompt 注入：`createUserMessage` 构造 `source={kind:"plugin:dsh-event-gate", form:"notice", summary}`
  的 user 消息（v4 会话格式**拒绝**旧的 `{kind:"plugin", plugin}` 包装），
  再 `agent.runMaintenance(() => agent.followup(msg))` 投递，`await agent.whenIdle()`。
- 唤醒前需恢复该会话的模型选择与预设（`installModelSelection` + `agentPresets.mount`），否则工具全部 unknown。
- 同一目标会话只有一个投递管线；busy 最多尝试 3 次，重试间隔 5s、10s（指数退避，30s 封顶）。
- 当前队列是进程内存结构，不承诺崩溃恢复或跨重启持久化；每次入队、合并、重试、失败和完成均写审计历史。

## 测试

```bash
npm test
```

测试使用 Node 内置 `node:test`，无额外依赖，覆盖 token 脱敏、规则热更新、同会话串行恢复、事件合并与背压、busy 重试、历史并发裁剪、glob、IPv6 Host 和 HTTP 请求体边界。

## License

MIT
