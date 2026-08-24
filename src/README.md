# @deepseek-ai/dsh-history

> ⚠️ **重要声明**：本项目为**个人使用而开发**，仅按作者自身工作流演进。**后续仅修复严重 Bug，一般不接受新功能请求，也不承诺常规更新、维护或兼容性保证。** 使用前请知悉并自行评估风险。

为 DeepSeek Harness (dsh) 打造的**非线性会话历史插件**：任意 TURN 状态可快照、可回退（同会话 id 原地热重载），以 **git 影子仓库**为唯一事实源。

> **一句话**：dsh 的会话就像一条单向直线的 git 分支；本插件把每次 TURN 边界变成 git 提交，让您可以随时"checkout"回任意历史时刻——信息**真正从会话记录中消失**，不产生新会话、不重启进程。

---

## 目录

- [核心特性](#核心特性)
- [为什么这样设计](#为什么这样设计)
- [架构总览](#架构总览)
- [仓库布局](#仓库布局)
- [工作流程](#工作流程)
  - [快照](#快照)
  - [回退（跳转）](#回退跳转)
  - [时间线](#时间线)
- [安装与启动](#安装与启动)
- [构建与测试](#构建与测试)
- [HISTORY 面板使用指南](#history-面板使用指南)
- [HTTP API](#http-api)
- [`/history` 命令](#history-命令)
- [项目目录结构](#项目目录结构)
- [回退后的缓存契约（不会重建缓存）](#回退后的缓存契约不会重建缓存)
- [已知语义与边界](#已知语义与边界)
- [Model Experience](#model-experience)
- [许可证](#许可证)

---

## 核心特性

| 特性 | 说明 |
|---|---|
| **自动快照** | `turn/start`、`turn/end` 边界自动提交；也可手动快照 |
| **原地回退** | 同会话 id 物理文件替换 + 进程内热重载；**不重启、不新建会话** |
| **信息真正删除** | 回退后目标之后的消息/工具调用不在会话记录与官方日志文件中 |
| **零复制** | git 以 plumbing 方式直接跟踪官方 `session.jsonl.zstd` 与真实工作区，无 checkpoint 副本目录 |
| **git 唯一事实源** | 快照写 git、时间线读 git、回退取 git；无 index、无 family、无映射表 |
| **纯裸仓** | 会话仓库与工作区仓库均为 bare repo + plumbing（无 work-tree），零额外状态 |
| **多路版本** | `main`（原始路，永不移动）+ `road-<ts>`（跳转后内容真正变化才产生的新路） |
| **工作区快照与恢复** | 每轮次同时快照工作区文件；回退时可独立恢复工作区 |
| **DSH 原生 UI** | 历史面板完全对齐 DSH 设计语言（token、24px 圆角、胶囊按钮、事件流） |
| **`/history` 命令** | 与官方命令同链路（会话投影流即时触发），零轮询 |

---

## 为什么这样设计

项目调研并否决了四种方案，最终采用"**物理文件替换 + 热重载**"：

| 方案 | 形态 | 被否决的原因 |
|---|---|---|
| ① fork 分支 | 官方 `session.fork` 从历史 turn 切出新会话 | 会话越来越多，两个版本来回切换非常糟糕 |
| ② marker 软回退 | append 空 assistant 消息 + surface 替换 | 信息仍留在会话记录中，只是表面隐藏 |
| ③ 冷加载 | git checkout 会话文件 → 重启 dsh | 要重启，体验不可接受 |
| ④ restore 副本 | 从快照解析 → 创建新会话 → 归档旧会话 | 会话仍是"副本"，familyId/index 等复杂状态与极简偏好冲突 |
| ⑤ **本插件** | **同会话 id 物理文件替换 + 进程内热重载** | —— |

**红线（用户明确反对）**：fork/分支会话、marker/软回退、重启/冷加载、index/family/映射表、checkpoint 物理副本目录、裸仓 + 分离 work-tree 的复杂度。

**用户确认的偏好**：git 影子仓库是唯一事实源；零复制；按会话 id 1:1 命名仓库；分支 = git refs；回退双模式（会话/工作区）；极简。

---

## 架构总览

```
┌─ 快照层 ───────────────────────────────────────────────────┐
│  TURN.Start / TURN.End / 手动快照                            │
│  ① 工作区 plumbing 快照（先建，snap= 归因，未变则复用）      │
│  ② flush → 会话文件 hash → 与 base 比对：                     │
│       相同 → 零动作                                          │
│       不同 → commit-tree（父 = base，ws= 引用工作区提交）      │
│       base = 跳转目标 → 新建 road-<ts>；否则推进该 ref        │
└──────────────────────────────────────────────────────────────┘

┌─ 回退层 ───────────────────────────────────────────────────┐
│  ① 会话：git show 历史字节 → flush → detach agent            │
│            → detach session → 原子替换物理文件 → resume      │
│            git 零动作（纯 checkout）                         │
│  ② 工作区：read-tree + checkout-index（临时 index）恢复      │
└──────────────────────────────────────────────────────────────┘

┌─ 时间线层 ─────────────────────────────────────────────────┐
│  git log --all --topo-order → 解析 commit message           │
│  → 浏览器 SVG git 图（rail + 分叉曲线，只有 fork 无 merge）  │
│  → 每行附带该版本变动文件 chips（一次 git log 批量获取）     │
└──────────────────────────────────────────────────────────────┘
```

**核心不变式**：
- 跳转 = **纯 checkout**：只替换会话文件，git 零新建（无标记提交、无 abandoned ref）；
- 新分支（`road-<ts>`）**只在内容真正变化后**产生——"跳过去看看什么都没做"不留任何痕迹；
- `main` 永不移动；撤销回退 = 再跳回图上任意节点（main/road 都在图上）。

---

## 仓库布局

```
$DSH_HOME/.dsh-history/
├── repos/session-<uuid>.git      # 会话仓库（bare，纯 plumbing 快照）
│                                 #   快照：hash → 与 base 比对（相同跳过）
│                                 #   → commit-tree（父 = base）→ 推进 ref
│                                 #   refs：main=原始路（永不移动）
│                                 #         road-<ts>=跳转后内容变化的新路
├── repos-ws/<project>.git        # 工作区影子仓库（bare，plumbing 遍历快照）
│                                 #   按 project 隔离，消息带 session=<id> 归因
│                                 #   多会话共享同一 cwd 时加排他锁
└── backups/                      # 回退前备份（会话物理文件 + 工作区状态）
```

- 会话仓库按 id 命名（1:1），首次快照 init；
- 工作区快照走 plumbing 遍历（`hash-object`/`mktree`），跳过一切 `.git` 与排除规则——cwd 本身是 git 仓库时不会退化成单个 gitlink；
- 排除规则默认：`.git`、`node_modules`、`dist`、`build`、`.next`、`.cache`、`.venv`、`venv`、`__pycache__`、`.idea`、`.vs`。

---

## 工作流程

### 快照

**时机**：`turn/start`（会话开始前）、`turn/end`（AI 回复后）、手动快照。

**流程**（工作区先建，会话后建——避免同周期互引循环）：

1. **工作区仓库**（先建，消息带 `snap=` + `session=` 归因）：遍历 cwd → `hash-object`/`mktree`/`commit-tree` → 推进 `main`；未变树复用父提交（去重）；
2. **durability 屏障**：`ctx.sessions.flush(session)`；
3. **会话仓库**（裸仓，零拷贝）：官方文件 `hash-object -w` → 与 base 的 blob 比对：
   - **相同 → 零动作**（无提交、无 ref 变化）；
   - **不同 → `commit-tree -p <base>`** → 推进 ref（`base` = 跳转目标则新建 `road-<ts>`）。

**commit message 契约**（时间线解析依据，格式稳定）：

```
会话侧（后建，引用本次配对的工作区提交）：
  [TURN 0001][CHECK POINT][<ws-hash>]          # turn-start（存储格式）
  [TURN 0001][USER] <user预览>[ASST] <asst预览>[<ws-hash>]   # turn-end
  [TURN 0001][MANUAL][<ws-hash>]               # 手动快照
  [REWIND → <commit>]                          # 回退标记

工作区侧（先建，单行归因，无 ws 括号）：
  [TURN 0001][CHECK POINT]
  [TURN 0001][ASST] <asst预览>
  [TURN 0001][MANUAL]
```

> **重要**：UI 显示 `BASELINE` 标签对应存储格式 `[CHECK POINT]`（turn-start）。`BASELINE` 是消息发送前的工作区变动锚点；`TURN`（turn-end）同时快照消息与工作区。存储契约未变，保证历史兼容。

**CHECK POINT 门控**（turn-start 快照条件）：
- 工作区自上次快照**有变动**（`ws.reused !== true`）→ 才创建 BASELINE 快照；
- 工作区未变动 → 跳过，不产生冗余节点。

### 回退（跳转）

**会话回退链路**（顺序契约不可乱）：

```
1. 用户选择时间线行 → 选择「仅会话 / 仅工作区 / 会话和工作区」
2. git show 目标版本会话文件字节
3. 备份当前物理文件 → backups/
4. flush（durability 屏障）
5. detach agent（agents.detachEntered）
6. detach session（sessions.detachEntered → session/disposed → 游标退休）
7. 原子替换官方物理文件（同目录临时文件 + rename，node:fs）
8. agents.resume({ resumeSessionId }) 并恢复目标记录的信封
   （agent preset 重新 mount + provider/model 路由，保前缀缓存契约）
9. 前端重建视图（rebindView 链；异常降级整页刷新）
```

**工作区回退链路**：解析目标 commit 的 `ws=` 配对 → 备份当前工作区 → `read-tree` + `checkout-index`（临时 index，git 直接写文件，二进制安全）恢复。**不做 `git clean`**（新增文件保留，避免误删）。

**三种模式**：
- **仅会话**：只回退会话消息（热重载）；
- **仅工作区**：只把工作区文件恢复到该版本，不动会话；
- **会话和工作区**：两者同时回退。

### 时间线

- 数据源：`git log --all --topo-order --pretty=format:%H|%P|%s|%ct`（`--all` 使 road 分支可见，`%P` 供 lane 分配）；
- 浏览器纯 SVG 手绘 git 图（零第三方图库），支持：lane 分配、分叉曲线、HEAD 定位、悬停祖先链高亮（蓝）、非主路置灰、节点放大、变动文件 chips；
- 时间线窗口化：默认 HEAD ±20 条；滚动到两端自动加载历史/后续版本（窗口切片 + 滚动锚定，数据全量在内存）。

---

## 安装与启动

```bash
# 添加插件（developer 模式 link）
dsh plugin --profile web add <本仓>
```

profile 补丁行（`inject` 声明行级服务依赖）：

```yaml
- insert:
    - id: dsh-history
      name: '@deepseek-ai/dsh-history'
      inject: [subprocess, sessions, webServer, sessionPersistence, agents]
```

**独立验证环境**（不动主实例）：

```bash
# 一次性创建（已存在则跳过）：
mkdir $DSH_HOME/profiles/dsh-history-dev
#   package.json: dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
#   cordis.patch.yml: 上面 insert 行
#   pnpm-workspace.yaml: packages: [.] + nodeLinker: hoisted + autoInstallPeers: false
pnpm --dir $DSH_HOME/profiles/dsh-history-dev add <本仓>

# 启动（端口 3082，绝不动主实例 3080）：
DSH_PERMISSION_MODE=danger-full-access dsh --profile dsh-history-dev --port 3082 --no-open
```

---

## 构建与测试

```bash
pnpm install          # 安装依赖（pnpm）
pnpm run typecheck    # TypeScript 类型检查
pnpm run build        # tsdown 构建 → lib/（index.js / invariant.js / client.js）
pnpm test             # 单元 + 真实 git 集成测试（temp 目录）
```

`lib/` 构建产物与 `package.json files` 一一对应（常量内联，无额外 chunk）。

---

## HISTORY 面板使用指南

- **打开方式**：
  - 会话 header 的 **HISTORY** 按钮（Session log 旁，回退图标）；
  - 或输入 `/history` 命令（**与官方命令同链路**：`command/run` 事件经会话投影流即时触发，零轮询）。
- **面板内容**：
  - 左：SVG git 图（分支 rail、分叉曲线、HEAD 空心环标记）；
  - 每行：BASELINE（工作区变动锚点）/ TURN（消息轮次）徽章、USER/ASST 消息预览、变动文件 chips（最多 12 个，超出显示 `… +N`）、commit 短 id、相对时间；
  - 悬停：祖先链高亮（蓝色）+ 节点放大 + 非路径元素置灰；
- **回退**：点击任意行 → 弹出 DSH 风格「回档」对话框（标题、commit id 加粗、三个按钮：仅会话 / 仅工作区 / 会话和工作区）；
- **快捷键**：打开后自动获得焦点；按 `Esc` 关闭；
- **关闭**：右上角 ✕（带背景与悬停高亮/放大 10%）或点击遮罩。

---

## HTTP API

Host 端在 `/dsh-history/api` 前缀下提供（loopback 白名单）：

| 路由 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/timeline` | GET | `sessionId` | git 图数据源（rows + meta + files） |
| `/status` | GET | `sessionId` | 影子仓库事实（mainTip / activeTip / repoExists） |
| `/snapshot` | POST | `sessionId` | 手动快照 |
| `/rewind` | POST | `sessionId, commit, restoreWorkspace, workspaceOnly` | 回退（三种模式） |
| `/purge` | POST | `sessionId, confirm: true` | 永久清理 abandoned 分支与备份（不可恢复） |
| `/export` | POST | `sessionId, target` | 克隆影子仓库到指定目录（调试） |

---

## `/history` 命令

```text
/history
```

- **零轮询**：host 端 `commands.register` 注册；命令执行产生 `command/run` 事件，经**会话投影流**推送到浏览器；前端注册 `conversation.chat.commandview` 的 `key: 'history'` 行组件，事件到达即弹出 HISTORY 面板——与官方命令 UI 同一条链路；
- 行内显示 `/history` 与执行状态，与官方命令行一致。

---

## 项目目录结构

```
E:\dsh-history\
├── src\                          # 插件源码
│   ├── index.ts                  # Host 入口：路由、快照监听、/history 命令
│   ├── snapshot.ts               # 快照（capture → workspace → session commit）
│   ├── rewind.ts                 # 回退链路（detach → replace → resume）
│   ├── timeline.ts               # 时间线 + 变动文件批量获取
│   ├── workspace.ts              # 工作区快照/恢复/备份
│   ├── messages.ts               # commit message 契约（build + parse）
│   ├── zstd-util.ts              # zstd 解码 / 消息预览提取
│   ├── store.ts                  # 影子仓库目录结构 / 锁
│   ├── git-commands.ts           # 所有 git argv 构建器
│   ├── git-runner.ts             # git 子进程封装
│   ├── purge.ts / export-repo.ts # 清理 / 导出
│   ├── state.ts                  # 跳转目标进程内状态
│   └── client\
│       ├── index.tsx             # Client 入口：面板 + 插槽注册 + /history 联动
│       ├── api.ts                # 前端 HTTP 客户端
│       ├── layout.ts             # git 图 lane 分配 / rail 几何
│       └── styles.ts             # DSH 风格注入样式
├── tests\                        # 单元 + 集成测试
├── lib\                          # 构建产物（发布用）
├── package.json                  # main/exports 指向 lib/
├── tsconfig.json
├── tsdown.config.ts              # 双端打包配置
├── pnpm-lock.yaml
└── README.md
```

---

## 回退后的缓存契约（不会重建缓存）

**问题**：DeepSeek / Anthropic 前缀缓存（KV cache）命中要求新请求前缀与已持久化单元**逐字节一致**。dsh 的 resume 会重建请求信封（system prompt + tools + route）；回退后如果直接裸 resume，重建的前缀与回退前历史在第一个字节就分叉——此后缓存永远无法命中，首轮响应退化。

**修复**（`rewind.ts` 步骤 7）：从目标文件字节解码两件事，然后按"组合改进 → 裸回退"顺序尝试 resume：

```ts
facts = decodeTargetFacts(目标字节):
  agentPreset  ← 目标 head 的 session 头字段；若有 `agent-preset/selected` 事件则后者胜出
  route        ← 目标最后一条 `request/header` 的 config（provider/model）

tries[0] = agents.resume({
  resumeSessionId,
  agentOptions: { provider, model },          // 路由与目标一致
  setup: async (agentCtx) => agentPresets.mount(agentCtx, facts.agentPreset),  // 重新挂载 preset
})
tries[1] = agents.resume({ resumeSessionId, agentOptions: { provider, model } })  // 降级
```

- tries[0] 成功 → 无告警，**缓存契约成立**：工具集（32 个）与系统提示段（与初始逐字节一致）恢复，路由恢复，消息前缀来自替换后的文件（字节级一致）——三段吻合，首轮 `cacheRead > 0`，后续轮次继续追加命中；
- tries[0] 失败、tries[1] 成功 → `compositionWarning`：会话可用但缓存退化；
- 两者都失败 → detached（resume-failed）。

**边界**：
- 目标无 preset 记录 → 只恢复路由（无警告）；
- 目标文件损坏 → decode 失败为空 facts → 裸 resume（不失败，仅缓存退化）；
- preset 已删除 → 降级 + `compositionWarning`；
- 工作区指令（AGENTS.md 等）变化同样改变 system prompt 前缀——"会话和工作区"一起回退时按目标时间对齐，指令一致；只回退会话时若指令文件已与目标不同，分叉属预期。

---

## 已知语义与边界

- **删除范围**：回退后目标之后的事件不在会话记录与官方日志文件中；git 影子历史与 `backups/` 保留（撤销/审计）；安全擦除走 `/purge`（不可恢复）；
- **回退后的缓存契约**：跳转时从目标文件恢复 agent preset（重新 mount，恢复工具集/系统提示）与 provider/model 路由——保证前缀缓存（KV cache）可继续命中；preset 挂载失败时降级为裸 resume 并提示 `compositionWarning`；
- **崩溃语义**：resume 前/后崩溃 → 磁盘 = 目标内容 + git 原样（从未因跳转写入）；进程重启后跳转目标丢失 → 快照沿现有路提交，git 自洽；
- **turn 计数**：从 base 路推导（跳回 C2 后下一轮 = C2 的 turn+1）；
- **工作区恢复不做 `git clean`**：新增文件保留（避免误删）；
- **多会话共享同一 cwd**：工作区回退影响该 cwd 下所有会话（文档化语义）；
- **重复实例警告**：只有单个 dsh 实例的会话仓库是安全的（回退期间 detach 后窗口极小）；不要对同一会话在多个实例并发操作。

---

## Model Experience

- **不注册工具**、不写会话事件、不改提示或上下文；
- 只在后台对会话文件/工作区做 git 快照，并在用户显式操作时回退；
- 回退改变的是物理文件（同 id 热重载），不产生新会话。

---

## 许可证

MIT
