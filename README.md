# dsh-event-gate

事件驱动触发器（"门铃"）：**文件变化 / 本地 webhook 命中规则后，唤醒指定 DSH 会话并注入 prompt。**
补上 [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)（"闹钟"：按时间自我唤醒）之外的另一半——**由外部世界叫醒**。

## 已实现（v0.3.0）

- **fs 事件源**：递归监视目录，按规则防抖合并（`{{paths}}` 带合并后的文件列表），glob 过滤
- **webhook 事件源**：`POST /__dsh-event-gate/hook`，按规则 token 鉴权，回环限定
- **唤醒**：活会话直接投递；冷会话 `agents.resume` 恢复后投递（恢复模型选择与预设，尽力而为）
- **规则热更新**：编辑 `rules.json` 保存即生效，无需重启 DSH
- **可观测性**：`trigger_list` / `trigger_history` 工具 + `/health` 路由 + JSONL 触发历史（每次触发都有记录，失败原因可查）

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
    "debounceMs": 3000,                // fs：防抖窗口
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

**模板变量**：`{{ruleId}}`、`{{source}}`；fs 规则另有 `{{count}}`、`{{paths}}`；webhook 规则有 `{{payload}}`（JSON，token 已剥离）。

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
  再 `agent.runMaintenance(() => agent.followup(msg))` 投递（忙时 throw → 退避重试），`await agent.whenIdle()`。
- 唤醒前需恢复该会话的模型选择与预设（`installModelSelection` + `agentPresets.mount`），否则工具全部 unknown。
- 护栏照抄：触发前持久化 in-flight 防崩溃双发；busy 30s 退避封顶；预算按"有可见回复"计费。

## License

MIT
