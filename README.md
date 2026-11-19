# dsh-im-lark

把飞书 / Lark 机器人接到 DeepSeek Harness：在飞书里私聊机器人，等于在 Web 端对话。

两条互相独立的使用路径：

| 模式 | 开关 | 需要「我的超级助理」 | 用途 |
| --- | --- | --- | --- |
| **接入核心** | 接入飞书 | 是 | 飞书当作 Web 端的一个入口：消息进 Web 会话，回答回飞书，问题/审批在飞书里作答 |
| **独立会话** | 接入飞书 + 接入我的超级助理 | 否 | 插件自己建会话，直接在飞书里聊；支持 `/help` `/new` `/sessions` 等命令 |

两个开关都打开时以 **核心** 为准，独立会话让位，避免同一句话被两处处理。

## 能力

- **收发消息**：文本、图片、文件；Markdown 以卡片渲染（代码块、表格、列表都能看）
- **引用回复**：回答默认引用提问，长回答按平台上限切段
- **处理反馈**：收到消息打 `Typing` 表情，回答完移除；没有官方「正在输入」接口
- **卡片更新**：流式回答原地更新同一张卡片；超过平台限制（14 天、单卡 5 QPS）后改为发新卡
- **交互卡片**：选择题、确认按钮直接在飞书里点，点击结果回到会话
- **消息管理**：可编辑已发消息、撤回（平台默认 24 小时内）
- **群聊**：只响应 @机器人 的消息，不会读全群
- **面板**：Web 端设置里填 App ID / App Secret、看连接状态、改提醒与独立会话设置

## 安装

```bash
npm install
npm run build
```

在 profile 的 `cordis.patch.yml` 里加上插件（`dsh plugin add` 或手动编辑都行）：

```yaml
- id: dsh-im-lark
  name: dsh-im-lark
```

重启 `dsh web`，打开 **设置 → 插件 → dsh-im-lark** 填写凭据。

## 飞书侧准备

1. 在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**，拿到 App ID 与 App Secret。
2. **添加应用能力 → 机器人**。
3. **权限管理**开通：
   - `im:message`（读取与发送单聊消息）
   - `im:message.group_at_msg`（接收群里 @机器人 的消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
   - `im:resource`（上传/下载图片与文件）
   - `im:message.reaction`（表情回应，用于「正在处理」）
4. **事件与回调 → 事件订阅**：选择**长连接**，订阅：
   - `im.message.receive_v1`
   - `card.action.trigger`（需要卡片交互时）
5. **发布版本**并等管理员审核通过；未发布前只有开发者自己能用。

> 长连接模式不需要公网地址、不需要配置请求网址。每个应用最多 50 条长连接，多实例部署时**只有一条**连接会收到事件，所以不要靠多开进程做水平扩展。

## 配置

静态配置写在 profile 的 patch 里，改完重启生效：

```yaml
- id: dsh-im-lark
  name: dsh-im-lark
  config:
    domain: feishu          # feishu（默认）或 lark（国际版）
    maxText: 2000           # 单条消息字符上限，超出自动切段
    typingIndicator: true   # 收到消息时打 Typing 表情
    questionReminders: true # 问题/审批提醒
    replyStatus: false      # 回答末尾附加模型、耗时、token
    longTaskThresholdMinutes: 30
    questionDelayMinutes: 5
    directBusyMode: interrupt # 独立会话里回合进行中又来消息：interrupt 打断 / queue 排队
```

面板能改的项会落到 `$DSH_HOME/.dsh-im-lark/config.json`，卸载重装后沿用。凭据单独存 `credentials.json`，目录 0700、文件 0600，日志与面板快照里只出现 App ID 尾号。

## 独立会话命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令列表 |
| `/new` | 开新会话 |
| `/sessions` | 列出最近会话，切到指定会话 |
| `/status` | 当前会话、模型、连接状态 |
| `/stop` | 中止正在跑的回合 |
| `/trace` | 查看上一条回答的模型与耗时 |
| `/send <文本>` | 不经模型，直接发一段文本 |

## 限制（平台决定，不是实现取舍）

- 事件处理必须 **3 秒内** 返回，重活一律异步做
- 文本消息体 ≤ 150 KB，卡片 ≤ 30 KB，超了平台直接拒收
- 发消息 5 QPS（按用户 / 按群），插件内置限速与退避
- 同一张卡片可 PATCH 14 天、单卡 5 QPS；超时后改为新发消息
- 图片 ≤ 10 MB，文件 ≤ 30 MB，上传前本地先拦一道
- 编辑消息有次数上限，撤回窗口由管理员配置（常见 24 小时）
- 没有官方「正在输入」接口，只能用作表情作为弱提示

## 开发

```bash
npm run typecheck   # 类型检查（测试文件一起查）
npm test            # 单元测试
npm run build       # tsc 编译 host + esbuild 打 client 单文件
npm run verify      # 校验产物、依赖白名单、patch 只增不删
npm run check       # 上面四步全跑
```

目录：

```
index.ts             入口，转出 src/host/index.ts
src/host/            宿主侧：连接、入站、出站、卡片、桥接、独立会话、面板 RPC
src/client/          Web 面板（React，打成单文件 lib/client.js）
src/shared/          两侧共用的常量与版本
locale/              面板文案
docs/design/         方案设计
docs/protocol/       飞书开放平台事实（含来源链接）
docs/adr/            架构决策记录
```

改代码前读 `AGENTS.md`（文件规模、日志脱敏、不引新依赖等硬规则）。

## 许可

MIT
