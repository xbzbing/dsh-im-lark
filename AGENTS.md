# AGENTS.md

给在本仓库里干活的 agent 看的硬规则。与 `docs/design/方案设计.md` 冲突时，以设计文档为准并同步改这里。

## 这是什么

飞书 / Lark IM 桥插件：`my-superagent/v1` 的实现方，同时也是能自己跑会话的独立客户端。宿主是 DeepSeek Harness（Cordis 插件）。

## 不能做的事

1. **`apply()` 不得返回普通对象**（Cordis 会当成 effect，报 `Invalid effect`）。可以是 `async`，但先登记 `ctx.effect` 清理，再 `await` 异步初始化；启动失败只记日志，不把插件带崩。
2. **不引新依赖**。唯一允许的运行时依赖是 `@larksuiteoapi/node-sdk`（`scripts/verify-package.mjs` 会拦）。要加依赖先改白名单并在 ADR 里写理由。
3. **不依赖 `dsh-my-superagent` 的包与类型**（devDependency 也不行）。桥接协议用本仓库 `src/host/protocol.ts` 的最小结构类型描述；一致性契约在 `test/unit/bridge.test.ts` 里本地自测。
4. **不在日志、错误信息里出现 App Secret 或完整 App ID**；日志与错误信息只允许 App ID 尾号六位。面板可以显示完整 App ID（App ID 不是密钥），但 App Secret 永不出现在任何地方。
5. **不整篇重写别人的文件**。改动用定向编辑；`tsc` 报错先看错误码，不要靠猜。
6. **不把 SDK 类型泄漏到 `lark/` 之外**。`@larksuiteoapi/node-sdk` 只在 `src/host/lark/sdk.ts` 里出现，其余文件面向 `lark/api.ts`、`lark/connection.ts` 的端口。
7. **不提交 `docs/local/`、`docs/review/`、`lib/`、`node_modules/`**。
8. **不写没验证过的平台事实**。飞书行为要么有官方链接（记进 `docs/protocol/`），要么标「未验证」并写清怎么验证。

## 文件规模

单个源文件超过约 500 行就该拆。当前分层就是按这个切的：

- `lark/`（`types` `errors` `api` `connection` `sdk`）：平台适配，只认飞书概念
- `inbound.ts` / `outbound.ts`：事件进来、消息出去，纯转换 + 限速
- `cards.ts`：卡片 JSON 构造与 PATCH 节流
- `bridge.ts`：`my-superagent/v1` 的 provider / handle 实现
- `standalone.ts`：独立会话与命令分发（解析在 `standalone-command.ts`，`/send` 编排在 `standalone-send.ts`，`/switch` 编排在 `standalone-switch.ts`）
- `session-list.ts` / `session-watch.ts`：`/sessions` 的列表与序号、`/send` 等一轮回答
- `reactions.ts` / `done-align.ts`：表情反馈的取值与「哪条消息答完了」的对齐
- `panel-*.ts`：面板 RPC 与 React

新增能力先想清楚落在哪一层，别往 `index.ts` 里堆。

## 协议要点（容易踩）

- 草稿的 `messageId` 是**去重键**，`platformMessageId` 才是 `replyTo` 里要逐字匹配的那个。
- 核心的 `Delivery.recipient` 是草稿的 `sender`（飞书是 open_id），`inReplyTo` 是草稿的
  `messageId`；桥负责翻译成 `chat_id` 与平台 `message_id`，不要直接透传。
- `Receipt.bridgeMessageId` 是平台消息 id；切段发送时 `bridgeMessageIds` 要给全，`messagesSent` 用于配额核算。
- `Delivery.id` 是幂等键：同 id 重投不得重复发消息。
- `stream` 的 revision 只能递增；`supersedes` 必须让旧卡片失效。
- 错误码只能是 `window-closed | rate-limited | auth-expired | too-long | other`。
- 审批类交互在 IM 侧一律回 `not-allowed`。

## 平台要点（容易踩）

- 事件处理 3 秒内必须返回；重活入队后再做。
- 去重按 `message_id`，不是 `event_id`。
- 群消息只有 @机器人 才会推送（`im:message.group_at_msg`）。
- 文本体 ≤ 150 KB、卡片 ≤ 30 KB；超长先切段，别等平台报 230025。
- 发消息 5 QPS（按用户 / 按群），走内置限速，429 用 `retryDelayMs` 退避。
- 卡片 PATCH 只在 `interactive` 类型、14 天内、单卡 5 QPS 有效，且要 `config.update_multi: true`。
- 没有官方「正在输入」接口 → 用表情兜底：收到打 `Get`；回答真正送达后才在原消息追加 `DONE`（入队不算完成，提醒作答在结算成功时当场打，没答完不打），失败静默；同一消息的 `DONE` 在栈层去重。核心模式只认核心的 `Delivery.completes`（`owner-message-completion`），**不按 intent/refs/标题猜**——猜会误打也会漏打；旧核心不发就不打。
- 长连接不广播：多实例只有一个收到事件，不要设计成集群消费。

## 验证阶梯

改完必须能过：

```bash
npm run typecheck && npm test && npm run build && npm run verify
```

涉及真实平台行为（卡片渲染、上传、频控、撤回窗口）的改动，在 `docs/review/` 留一份测试记录（该目录不入库），写清应用、租户、时间、实际现象。没有真机验证的能力不要写进 README 的「能力」小节。

门禁自包含：不依赖私有核心，公开 CI 跑的就是全量。

## 发布

- 发布只走 `.github/workflows/release.yml`（main 上 `package.json` 变更触发），不手工打 tag、不本地 `npm publish`（首次 bootstrap 见 ADR-0007）
- 版本三处同步：`package.json`、`package-lock.json`、`src/shared/version.ts`；正式版正文写 `docs/releases/v<版本>.md`，预发布不写文件（正文由 workflow 生成）
- 预发布发 npm 频道标签（`stage` / `rc`），`latest` 只给正式版
- 发布正文是中英双语，格式见 `.github/RELEASE_TEMPLATE.md`
- README 也是中英双语：`README.md`（中文）与 `README.en.md`（英文）必须同步改；两边的 hero 图分别引用 `assets/hero.zh.png` / `assets/hero.en.png`（可编辑源文件是同名 `.svg`，改图后重新导出 PNG）

## 提交

- Conventional Commits，标题用中文，例如 `feat(inbound): 解析引用与 @ 提及`
- 一个模块一个提交，构建产物与源码分开
- 只本地提交，不 push
