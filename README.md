# @deepseek-ai/dsh-history

**非线性会话历史**：任意 TURN 状态可快照、可回退（同会话 id 原地热重载），以 git 影子仓库为唯一事实源。设计依据见 `开发文档.md`（§4 最终方案；§2 记载了被否决的方案与红线）。

## 是什么

- **快照**：每次 `turn/start`、`turn/end`（以及手动「快照」按钮）都会与当前 **base** 做 diff 驱动提交：
  1. **工作区仓库**（`$DSH_HOME/.dsh-history/repos-ws/<project>.git`，纯裸仓）：plumbing 遍历 cwd（跳过一切 `.git` 与排除规则，嵌套 git 仓库不会退化成 gitlink）→ `hash-object`/`mktree`/`commit-tree` → `main`；未变树复用父提交（去重）；消息带 `session=<id> snap=<snap>` 归因；
  2. **会话仓库**（`$DSH_HOME/.dsh-history/repos/session-<id>.git`，纯裸仓）：官方 `session.jsonl.zstd` 由 git 自己读入（零拷贝、二进制不过我们进程）→ 与 base 的 blob 比对：**相同 → 零动作**；不同 → 固定树路径 `session-<id>/session.jsonl.zstd` → `commit-tree -p <base>` → 推进 ref；消息 `turn N start|end (seq M) session-<id> snap=<snap> base=<base> ws=<工作区提交>`。
- **base 解析**（git 为主 + 进程内跳转目标）：① 跳转目标（进程内，由回退设置）→ ② 最新 `road-<ts>` tip → ③ `main` tip。
- **回退（跳转）**（双 checkbox：☑ 会话（默认）☐ 工作区）= **纯 checkout**：同会话 id 原地回到历史时刻——备份 → 原子替换物理文件 → resume；**git 侧零动作**（main 不动、无新提交、无新 ref、无分支）。
- **新分支（road-<ts>）只在内容真的变化后产生**：跳回 C2 后继续对话 → 快照内容与 C2 不同 → `road-<ts>` 分支提交（父=C2），main 原路不动；跳过去什么都不做 → 什么也不产生。
- **时间线**：`git log --all --topo-order --pretty=format:%H|%P|%s|%ct` → 浏览器以 SVG 画 git 图（rail + 分叉曲线，无合并，只有 fork；跳转本身无节点）。

## 安装

```
dsh plugin --profile web add <本仓>
```

profile 补丁行需（`inject` 声明行级服务依赖，激活顺序由 cordis 保证）：

```yaml
- insert:
    - id: dsh-history
      name: '@deepseek-ai/dsh-history'
      inject: [subprocess, sessions, webServer, sessionPersistence, agents]
```

## 构建与验证

```
pnpm install
pnpm run typecheck
pnpm run build
pnpm test            # 单元 + 真实 git 集成测试（temp 目录）
```

## 独立验证环境

```
# 一次性创建（已存在则跳过）：
mkdir $DSH_HOME/profiles/dsh-history-dev
#   package.json / cordis.patch.yml / pnpm-workspace.yaml 见下方示例
pnpm --dir $DSH_HOME/profiles/dsh-history-dev add <本仓>

# 启动（绝不动主实例）：
DSH_PERMISSION_MODE=danger-full-access dsh --profile dsh-history-dev --port 3082 --no-open
```

profile 示例（`$DSH_HOME/profiles/dsh-history-dev/`）：

- `package.json`：`dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`
- `cordis.patch.yml`：上面的 insert 行
- `pnpm-workspace.yaml`：`packages: [.]` + `nodeLinker: hoisted` + `autoInstallPeers: false`

## 边界与已知语义

- **删除范围**：回退后目标之后的事件不在会话记录与官方日志文件中；git 影子历史与 `backups/` 保留（撤销、审计）。安全擦除走 `POST /dsh-history/api/purge`（`{sessionId, confirm: true}`，不可恢复：删 road refs / reflog / 不可达对象 + 备份轮换保留最新 3 个）；面板「清理」按钮为两次点击确认。
- **跳转零 git 痕迹**：main（原始路）永不移动；road 分支仅在内容变化后产生；「跳过去看看什么都没做」不留任何历史。撤销回退 = 再跳回图上任意节点（main/road 都在图上）。
- **回退后的缓存契约**：DeepSeek/Anthropic 前缀缓存要求后续请求与已缓存前缀逐字节一致。跳转后 dsh 会重建请求信封，因此回退时插件从目标文件恢复两件事——① 目标记录的 agent preset（重新 `mount`，恢复工具集/系统提示段）；② 目标最后一条 `request/header` 的 provider/model（恢复路由）。二者都失败时才降级为裸 resume（此时面板提示 `compositionWarning`，缓存大概率保不住）。已实测：跳转后首轮 `cacheRead > 0`，信封（tools/systemLen）与跳转前逐字节一致。
- **崩溃语义**：resume 前/后崩溃 → 磁盘 = 目标内容 + git 原样（从未因跳转写入 git）；进程重启后跳转目标丢失 → 快照沿现有路提交，git 自洽。
- **turn 计数从 base 路推导**：跳回 C2 后下一轮 = C2 的 turn+1（沿跳转目标的祖先扫描，而非原始路 tip）。
- **workspace 恢复不做 `git clean`**：新增文件保留（避免误删）；二进制经 `read-tree`+`checkout-index`（临时 index，事后删除）由 git 直接写文件——绝不走 subprocess stdout（zstd/二进制安全）。
- **workspace 恢复不做 `git clean`**：新增文件保留（避免误删）；二进制经 `read-tree`+`checkout-index`（临时 index，事后删除）由 git 直接写文件——绝不走 subprocess stdout（zstd/二进制安全）。
- **多会话共享同一 cwd**：repos-ws 提交带 session 归因 + 每 project 排他锁；工作区回退影响该 cwd 下所有会话（文档化语义）。
- **turn/start 与 AI 首个工具调用的竞态**：快照在事件后异步执行（保证 append 链路不被拖慢），极端情况下工作区快照可能捕获到首个工具调用前的状态；需要严格一致时按住手动快照（在工具调用前点）或暂时接受。
- **重复实例警告**：只有单个 dsh 实例的会话仓库是安全的（回退期间 detach 后窗口极小）；不要对同一会话在多个实例并发操作。

### 已知实现偏离（比文档更安全处）

1. §4.4 步骤 3/4：先 `flush` 再备份当前文件（备份代表落盘后的真实状态），文档顺序为备份→flush；
2. §4.4 工作区/会话字节恢复：`git show`/`ls-tree + node:fs` 改为**临时 index 的 `read-tree`+`checkout-index`**（git 直接写文件，二进制安全），语义等价；
3. 首个快照无锚点：消息省略 `base=`（而不是写 `base=` 空值）——解析器两种都兼容。

## 查看影子 git 图（VS Code / 终端）

影子仓库是纯裸仓（无工作树），VS Code 的 SCM 面板不能直接打开；用辅助脚本克隆到临时目录后用 VS Code 打开（只读、可随时删除），main 与 road-* 分支（跳转后内容变化的新路）、提交图全部可见——跳转本身零节点；旧会话若留有 abandoned-*（旧模型遗留）同样可见：

```
.\view-history.ps1 e2e-clean          # 会话仓库（按名称/前缀/子串匹配）
.\view-history.ps1 -Workspace ws-e2e  # 工作区仓库
# 或终端直查：
git --git-dir=$DSH_HOME\.dsh-history\repos\session-<id>.git log --graph --all --oneline --decorate
```

注意：会话提交里是完整的 zstd 会话文件（二进制），单文件 diff 会显示"二进制差异"——设计如此（快照 = 整文件版本，非增量）；看分支结构/commit message 即可。克隆是只读副本，不要向影子仓库 push。

## Model Experience

不注册工具、不写会话事件、不改提示或上下文；只在后台对会话文件/工作区做 git 快照，并在用户显式操作时回退。回退改变的是物理文件（同 id 热重载），不产生新会话。

## 可选：invariant 伴侣

`src/invariant.ts`（lib/invariant.js）按官方协议导出 `{name, inject:['invariants'], apply}`，仅在显式挂载时生效：

```yaml
- insert:
    - id: dsh-history-invariant
      name: '@deepseek-ai/dsh-history/invariant'
      inject: [invariants]
```

不挂载则完全惰性（普通入口点不依赖诊断）。

## 打包说明

`lib/` 由 `pnpm build` 生成，与 `package.json files`（index.js / invariant.js / client.js）严格一一对应——常量被内联，不存在需额外携带的 chunk（历史上曾出现过 `constants-<hash>.js` 拆包，已在拆包路径上修复）。
