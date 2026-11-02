# dsh-parallel-worktree

[![CI](https://github.com/wang-yi-bit64/dsh-parallel-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/wang-yi-bit64/dsh-parallel-worktree/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-parallel-worktree.svg)](https://www.npmjs.com/package/dsh-parallel-worktree)

给 DSH 加上「多分支并行开发」能力的插件：为每个任务开一个独立的 git worktree，让多个 Agent / 多个终端在同一仓库上并行干活，互不污染。

它补的是 DSH 内置 `create_worktree` 之外的一层工程化：内置工具只负责「建一个检出」，这个插件负责**注册表、布局约定、环境引导、同步/合并/清理的收尾闭环**，以及一条给人类用的 `/worktree` 命令。

> 本文件是中文主文档。英文版见 [README.en.md](./README.en.md)。

---

## 界面与可见性

插件装好并重启 DSH Desktop 后，打开 **设置 → 插件**，插件列表里会出现本插件的卡片：

- **标题**：中文界面显示「并行 Worktree（多分支并行开发）」，英文界面显示 `Parallel Worktrees`；
- **描述**：一句话说明能力边界（同样分中英文两份）；
- **图标**：随包分发的 `icon.svg`，原创几何图形（一条基线 + 三个并行检出），用 `currentColor` 绘制，深色/浅色主题下都清楚。

这三样分别来自包内的 `locale/zh.json`、`locale/en.json` 和 `icon.svg`。DSH 的插件管理器/插件列表**无需激活插件**就会读取它们，所以即使插件还没启用，也能在列表里认出它是干什么的。任一字段缺失时会回退成 `package.json` 的 `name` / `description`；字段格式错误会在插件详情里显示一条诊断，而不是让整张卡片消失。

客户端半边（同一插件包里的 `client` 部分）在会话界面提供两块 UI：

- **Dock 徽标**：在**会话输入框下方的 composer dock** 里，只在 `/worktree status --json` 返回 `inWorktree: true` 时显示「⛛ <名字> <分支>」，否则完全不渲染；
- **worktree 面板**：点开徽标后向上弹出，列出该仓库全部 worktree，每行是名字 / 分支 / state / 是否脏 / **领先（↑n）/ 落后（↓n）** / 是否「当前」/ 完整路径，行内有一个「复制路径」按钮；顶部只有「刷新」与「关闭」。

面板**只读**：数据只走 `/worktree status --json`（挂载时一次）与 `/worktree list --json`（点开与刷新时各一次），没有轮询；面板里也没有新建、移除、合并入口——写操作按设计只留在 `/worktree` 命令与模型工具里（避免在 UI 里误点丢掉未提交改动）。面板、命令与工具读的是同一套管理器与同一份 `registry.json`，所以展示的永远是一份数据。

## 为什么需要它

内置 `create_worktree` 会把检出放进仓库内的 `.agents/worktrees/<name>`，并且只做创建一步。实际并行开发时你会反复遇到：

- 检出目录散落在仓库里，`git status` 被污染，要手工维护 `.gitignore`；
- 不知道现在开了哪些分支、各自脏不脏、领先/落后主分支多少；
- 新建的 worktree 没有 `.env`，`node_modules` 要重装；
- 主分支上还有未提交的改动，新 worktree 拿不到，还得手工 stash/patch；
- 收尾时要自己 merge、删目录、删分支，顺序错了留下烂摊子。

这个插件把上面这些变成可查询、可重复执行的操作。

## 功能

- **创建**：`worktree_create` 工具 + `/worktree create` 命令，自动 `git worktree add`、建分支、写注册表。
- **布局**：默认把 worktree 放在**仓库外**的兄弟目录 `<repo>.wt/`，主仓库永远干净；也可选择 `inside`（`<repo>/.worktrees/`，自动维护 `.gitignore`）。
- **环境引导**：可选把主仓库的未提交改动（`git diff --binary` + `apply --3way`）和未跟踪文件带进新 worktree；自动复制 `.env`/`.env.local`；可 junction/symlink 复用 `node_modules`（Windows 用 junction，不需要管理员权限）。
- **可见性**：`worktree_list` 给出一张表——分支、路径、是否还在、是否脏、HEAD、领先/落后基线多少。
- **同步**：`/worktree sync` 把基线合进来（默认 `rebase --autostash`，可切 `merge`），冲突自动 abort 并报 `MERGE_CONFLICT`。
- **合并收尾**：`/worktree merge` 在主仓库 `merge --no-ff`，可选 `--remove` 删检出、`--delete-branch` 删分支；主仓库脏或 HEAD 分离会直接拒绝。
- **清理**：`/worktree remove`（脏目录需 `--force`）、`/worktree prune`（清掉目录已消失的注册项）。
- **并发安全**：注册表写入用 `tmp + rename` 原子替换，跨进程用 `registry.lock` 文件锁；`batch` 一次建多个也走同一把锁。

## 安装

插件需要被 DSH 的 profile 组合进来（这是 DSH 插件的激活方式：`dsh.profile.bundles` 列出包名，DSH 启动时读它自带的 `cordis.patch.yml` 注入插件行）。

```powershell
# 在本仓库根目录（插件目录）执行
node install.mjs                    # 装进 %USERPROFILE%\.dsh\profiles\desktop
node install.mjs --dry-run          # 只看计划，不写文件
node install.mjs --profile <dir>    # 指定其它 profile
```

脚本做两件事：

1. 预检插件自身能否被当作 bundle 加载（`dsh.bundle.patch` 指向的 `cordis.patch.yml` 必须存在且在插件目录内）；
2. 把插件文件复制到 **`<DSH_HOME>/node_modules/dsh-parallel-worktree`**（默认 `%USERPROFILE%\.dsh\node_modules\`），并把 `dsh-parallel-worktree` 追加进 `dsh.profile.bundles`。

**为什么装在 `~/.dsh/node_modules` 而不是 profile 里？** profile 目录本身是一个 pnpm 工程（有 `pnpm-lock.yaml`、`node_modules/.modules.yaml`），DSH 的插件管理器会跑 `pnpm install`，**没有写进 `dependencies` 的目录会被当作多余文件删掉**。删掉之后启动就会报：

```text
dsh: cannot resolve profile bundle "dsh-parallel-worktree" from the dsh installation or <profile>; run 'dsh plugin --profile <name> install' if its dependency is not installed
```

`~\.dsh\node_modules` 是 Node 解析 `node_modules` 时的上级目录，DSH 的 `app-boot` 用 `require.resolve.paths()` 从上往下找，所以放这里一样能被找到，而 pnpm 从不管理它——应用内更新插件、跑多少次 `pnpm install` 都不会删。

改 `package.json` 前会备份成 `package.json.bak-<时间戳>`，写入失败自动回滚。`--no-bundles` 只复制文件不改 bundles，`--force` 跳过同版本提示。复制时会带上 `locale/`、`icon.svg` 与全部运行期文件——插件列表里的标题、描述、图标依赖它们，缺一个卡片就会退化成包名。脚本还会顺手删掉老版本留在 `<profile>/node_modules` 里的副本。

**不要手工往 `dependencies` 里加这个包。** DSH 的激活只看三件事：包声明了 `dsh.bundle`、包名在 `dsh.profile.bundles` 里、包文件能被解析到（`node_modules` 或宿主安装目录）。写 `dependencies` 却不跑 pnpm 会让 `pnpm-lock.yaml` 与包不一致。想走正规 npm 流程时，用包管理器装完再确认 bundles 里有它即可。

**改完必须完全退出并重启 DSH Desktop**（关窗口不算），profile 在启动时 compose；profile 目录在桌面运行期带写锁，安装脚本应在桌面退出后执行。

验证：在任意 git 仓库的会话里执行 `/worktree help`，能看到子命令列表即注册成功（`/worktree help` 不依赖任何 git 状态，`/worktree list` 才需要仓库）。若命令没出现，看 `<profile>/.plugin-manager/logs` 里最近的日志——常见失败是 `ERR_MODULE_NOT_FOUND ... imported from <profile>/`（包文件没复制到位）和 `declares no dsh.bundle`（`dsh.bundle.patch` 缺失）。

## 一分钟上手

两条路，任选一条。

### A. 直接用斜杠命令

在仓库（主工作区，或已存在的某个 worktree）里，任意会话输入：

```text
/worktree create feature/login
/worktree list
/worktree path feature/login
```

`create` 的典型输出：

```text
✓ 已创建 worktree feature/login
  分支   wt/feature/login
  路径   D:\code\portal.wt\feature\login
  起点   main @ 4f3c9a1b
  注册表 D:\code\portal.wt\registry.json

在终端 cd 到上面的路径，或在新会话里把它设为工作目录；该目录的改动与主工作区隔离。
```

拿到路径后：`cd` 过去开终端，或在 DSH 里新建会话并把工作目录设为它。`list` 给出总表，`path` 只打印路径（方便复制）。

### B. 让 AI 来做

同一件事用对话表达（可以直接粘贴）：

```text
帮我为「登录页改版」开一个独立的 worktree：从 main 拉，名字用 feature/login，
并把主工作区当前未提交的改动一起带过去。之后所有改动都只在这个目录里做。
```

Agent 会调用 `worktree_create`：

```json
{ "name": "feature/login", "base": "main", "carryUncommitted": true }
```

返回结果（节选，实际是 JSON 文本）：

```json
{
  "name": "feature/login",
  "branch": "wt/feature/login",
  "path": "D:\\code\\portal.wt\\feature\\login",
  "repoRoot": "D:\\code\\portal",
  "baseCommit": "4f3c9a1b...",
  "createdAt": "2026-11-03T06:12:40.000Z",
  "manifestPath": "D:\\code\\portal.wt\\registry.json",
  "warnings": []
}
```

Agent 拿到 `path` 后会把工作目录切到该目录再改文件（切换动作由会话自己完成，插件不改会话工作目录）。

## 用法示例：五个场景

每个例子都是「你对 Agent 说什么 → Agent 调什么 → 结果长什么样」。合并、删除这类收尾动作没有模型工具，需要你自己敲命令。

### 1. 开一个新任务

```text
你：开个 worktree 做支付重试，名字 feature/pay-retry，基线用 release/1.8，
    依赖直接复用主仓库的 node_modules，别重新装。
Agent：worktree_create({ name: "feature/pay-retry", base: "release/1.8", linkNodeModules: true })
```

结果：新检出 `<repo>.wt/feature/pay-retry`，分支 `wt/feature/pay-retry`，起点是 `release/1.8` 的提交；`node_modules` 以 junction 链到主仓库，秒级可用。

### 2. 查看全部 worktree

```text
你：这个仓库现在开了哪些 worktree？谁有未提交改动、谁落后 main？
Agent：worktree_list({})
```

返回里 `worktrees` 是数组，每项含 `name` / `branch` / `path` / `state` / `exists` / `dirty` / `head` / `ahead` / `behind`；`ahead` 是相对基线的领先提交数，`behind` 是落后数。`state` 为 `active`（正常）/ `merged`（已合并）/ `missing`（目录已丢失，可 `/worktree prune`）。

### 3. 切到某个 worktree 里干活

```text
你：我要改 feature/login 那个检出，帮我把会话工作目录切过去。
Agent：worktree_status({ name: "feature/login" })  → 拿到 path
Agent：（切换会话工作目录后）现在在这个目录里，状态：干净、领先 2 / 落后 0。
```

不值当开新会话时，也可以 `/worktree path feature/login` 拿到路径自己 `cd`。

### 4. 同步基线

```text
你：feature/login 落后 main 了，把最新 main 同步进去；有冲突就停下告诉我。
（人类命令，Agent 不能代执行）
/worktree sync feature/login --base main
```

输出：`✓ 已把 main 同步进 worktree feature/login（rebase）`，附 `BASE 4f3c9a1b` / `HEAD 9a12e77c`；同步前有未提交改动时会多一行 `注意：同步前存在未提交改动（rebase 已自动 autostash）`。真冲突会自动 abort 并报 `MERGE_CONFLICT`，worktree 停在同步前的状态。

### 5. 合并收尾并清理

```text
你：feature/login 测完了，合进 main，然后把检出和分支都删掉。
/worktree merge feature/login --base main --remove --delete-branch
```

输出：`✓ 已把 wt/feature/login 合并进 main` + 合并提交 SHA + `checkout  已移除` + `分支      已删除`；如果当时主工作区不在 main 上，还会多一行 `主工作区已从 <旧分支> 切换到 main`。删完后 `/worktree list` 里就没有它了。

## 命令参考

### `/worktree` 子命令

| 子命令 | 别名 | 参数 | 作用 | 输出要点 |
| --- | --- | --- | --- | --- |
| `create` | `new` | `<name> [--base <ref>] [--carry] [--link] [--no-env]` | 新建隔离检出 + 分支 + 注册表 | `✓ 已创建 worktree <name>`、分支、路径、起点 `<baseRef> @ <sha8>`、注册表路径；有警告时列在 `警告：` 下 |
| `batch` | — | `<name1> <name2> ... [--base <ref>]` | 依次创建，逐项收集失败 | `批量创建：成功 N，失败 M`；每行 `✓ 名字 → 分支 路径` 或 `✗ 名字 [CODE] 消息`；有失败时整条按 error 返回 |
| `list` | `ls` | — | 表格列出全部 worktree | 表头 `# 名字 分支 状态 脏 HEAD 领先/落后 路径`；首次使用会提示「还没有注册任何 worktree」 |
| `status` | `st` | `[name]` | 查看指定项，或当前会话所在项 | `worktree <name>` + 分支/路径/状态/脏/HEAD/相对主干 领先 X / 落后 Y/创建于；不在受管理目录时给出仓库与根目录 |
| `path` | — | `<name>` | 只打印检出目录，便于复制 / `cd` | 一行绝对路径 |
| `sync` | — | `<name> [--base <ref>] [--merge\|--rebase]` | 把基线同步进 worktree | `✓ 已把 <base> 同步进 worktree <name>（<mode>）` + BASE/HEAD；冲突自动 abort |
| `merge` | — | `<name> [--base <ref>] [--message <msg>] [--remove] [--delete-branch]` | 在主工作区 `merge --no-ff` | 合并提交 SHA + 是否切换主工作区 + 检出/分支的去留；默认两者都保留 |
| `remove` | `rm` | `<name> [--force\|-f] [--delete-branch]` | 移除检出（可选删分支） | 路径 + 分支去留；脏目录不加 `--force` 会拒绝 |
| `prune` | — | — | 清理「目录已消失」的注册项 | `✓ 没有需要清理的注册项（保留 N 个）`，或逐条列出被清理项 |
| `help` | — | —（空输入、`-h`、`--help` 同） | 帮助 | 子命令速查 |

参数三种写法都认：`--base main`、`--base=main`、短选项 `-f`。参数按空格切分，含空格的值用引号包起来（`--message "fix: login redirect"`）。

`merge` 默认**保留**检出和分支（先确认再删更安全）；要一步收尾就显式加 `--remove --delete-branch`。

### `--json`：结构化输出

任意子命令都可加 `--json`（简写 `-j`），把结果作为一行 JSON 文本返回，供客户端面板与脚本解析；它只改变输出格式，不改变任何行为或权限。

成功统一是 `{ "ok": true, "action": "<子命令>", ... }`，各 action 的字段：

| action | 字段 |
| --- | --- |
| `create` | `name`、`branch`、`path`、`baseRef`、`baseCommit`、`repoRoot`、`wtRoot`、`manifestPath`、`warnings[]` |
| `batch` | `created[]`（`name` / `branch` / `path`）、`failed[]`（`name` / `code` / `message`） |
| `list` | `repoRoot`、`wtRoot`、`layout`、`baseBranch`（探测不到为 `null`）、`registry`、`worktrees[]`（字段与 `worktree_list` 工具一致） |
| `status` | `repoRoot`、`wtRoot`、`layout`、`baseBranch`（探测不到为 `null`）、`inWorktree`、`worktree`（不在受管理目录时为 `null`） |
| `path` | `name`、`path` |
| `sync` | `name`、`branch`、`path`、`base`、`baseCommit`、`head`、`mode`、`dirtyBefore` |
| `merge` | `name`、`branch`、`base`、`mergeCommit`、`switchedFrom`、`removed`、`branchDeleted`、`note` |
| `remove` | `name`、`path`、`branch`、`deletedBranch`、`dirty` |
| `prune` | `pruned[]`（`name` / `path`）、`kept` |

`status` 的 `inWorktree=true` 表示当前会话的工作目录落在某个受管 worktree 内（客户端 Dock 徽标就是靠它判断的）；此时 `worktree` 是那一项的详情，在主工作区或未注册目录里则为 `null`。

失败时结果按 error 返回，文本是 `{"ok":false,"code":"...","message":"...","hint":"..." 或 null}`：`code` 与错误码表一致（如 `NOT_GIT_REPO`、`WORKTREE_NOT_FOUND`、`NAME_REQUIRED`），未知子命令是 `UNKNOWN_SUBCOMMAND`。`batch` 部分失败也仍返回 `ok: true`，失败项在 `failed[]` 里。

两个注意点：`/worktree` 是人类命令面，模型拿不到它——`--json` 只是输出格式，不会把命令能力开放给模型；JSON 仍走普通文本通道（`kind` 保持 `success` / `error`），所以旧宿主与既有解析逻辑都兼容。

### 三个模型工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `worktree_create` | `name`（必填）、`base`、`carryUncommitted`、`linkNodeModules`、`copyEnv` | 新建 worktree，返回新检出信息与警告 |
| `worktree_list` | 无 | 列出当前仓库全部 worktree 与状态 |
| `worktree_status` | `name`（可选） | 查当前会话所在或指定 worktree；不在任何受管理 worktree 时 `inWorktree` 为 `false` |

参数细节：

| 参数 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `name` | string，必填 | — | worktree 名，同时决定路径与分支名（默认分支 `wt/<name>`）。可含 `/` 分层，如 `feature/login`；每段由字母/数字/`. _ -` 组成，首字符为字母或数字；禁止 `..`、反斜杠、空格以及 `~ ^ : ? * [ ] @ { }`；总长 ≤100 |
| `base` | string | 主仓库当前分支（配置了 `baseBranch` 则用配置） | 起点 ref：分支、提交或 tag |
| `carryUncommitted` | boolean | `false` | 把主工作区未提交改动（`git diff --binary` 走 `apply --3way`）和未跟踪文件带进新检出；跳过 `node_modules/` 与 `.git/` |
| `linkNodeModules` | boolean | 插件配置（默认 `false`） | 把主仓库 `node_modules` 以链接挂进新检出（Windows 用 junction，无需管理员权限） |
| `copyEnv` | boolean | `true` | 复制插件配置的环境文件（默认 `.env`、`.env.local`） |

`worktree_create` 返回字段：

| 字段 | 含义 |
| --- | --- |
| `name` / `branch` / `path` | worktree 名 / 新建分支（`wt/<name>`）/ 检出目录绝对路径 |
| `repoRoot` | 主仓库根目录 |
| `baseCommit` | 起点提交 SHA（完整） |
| `createdAt` | 创建时间（ISO 8601） |
| `manifestPath` | 注册表 `registry.json` 路径 |
| `warnings` | 警告数组（如 `--link` 建立链接失败会降级成警告，不阻塞创建） |

`worktree_list` 返回 `repoRoot`、`wtRoot`（worktree 根目录）、`layout`（`sibling`/`inside`）、`baseBranch`（探测到的基线，可能缺失）、`registry`（注册表路径），以及 `worktrees[]`，每项：

| 字段 | 含义 |
| --- | --- |
| `name` / `branch` / `path` | 名字 / 分支 / 检出目录 |
| `state` | `active` \| `merged` \| `missing` |
| `exists` | 目录当前是否存在 |
| `dirty` | 是否有未提交改动 |
| `head` | 当前 HEAD 短 SHA（可能缺失） |
| `ahead` / `behind` | 相对基线领先 / 落后提交数 |
| `baseCommit` / `createdAt` / `lastSyncAt` | 创建时的基线提交、创建时间、最近同步时间（可能缺失） |

`worktree_status` 返回 `repoRoot`、`layout`、`inWorktree`（布尔），以及可选的 `worktree`：`name` / `branch` / `path` / `state` / `exists` / `dirty` / `head` / `ahead` / `behind` / `baseCommit`。`worktree` 缺失即表示当前在主工作区或未注册目录。

三个工具的渲染都是原始 JSON（单行文本块），没有额外美化——字段名本身是稳定契约。

## 典型并行节奏

```text
/worktree create feature/auth
/worktree create feature/pay
/worktree list                     # 看谁脏、谁落后
/worktree sync feature/auth --base main
/worktree merge feature/auth --remove --delete-branch
```

配合 Agent Teams：每个 teammate 用 `/worktree create` 拿到自己的目录，在各自 worktree 里改文件，最后由你按顺序 merge；目录互不相交，不会出现共享工作区互相踩写的问题。

## 配置

配置来自 `cordis.patch.yml` 里插件行的 `config`（或在 profile patch 里按 id 覆盖）：

```yaml
- id: parallel-worktree
  name: dsh-parallel-worktree
  config:
    layout: sibling          # sibling（仓库外 <repo>.wt/）| inside（<repo>/.worktrees/）
    dirName: .worktrees      # layout=inside 时的目录名
    siblingSuffix: .wt       # layout=sibling 时兄弟目录后缀
    branchPrefix: "wt/"      # 新建分支前缀
    baseBranch: main         # 未显式 --base 时的基线；不写则探测主仓库当前分支
    syncMode: rebase         # rebase | merge
    copyEnv: [".env", ".env.local"]
    linkNodeModules: false
    enabled: true
```

插件行本身长这样（`cordis.patch.yml`）：

```yaml
- insert:
    - id: parallel-worktree
      name: dsh-parallel-worktree
```

`enabled: false` 时插件整体跳过：不注册工具、不注册命令；插件列表里的卡片仍在（元数据是静态读的）。

## 目录与注册表

### 三种落点

检出放在哪儿由配置决定，共三条约定：

| 布局 | 触发条件 | 检出根目录 | `.gitignore` |
| --- | --- | --- | --- |
| 兄弟目录（默认） | `layout: sibling`（默认） | 与仓库同级的 `<repo>.wt\`，例如 `D:\code\portal` → `D:\code\portal.wt\` | 不用，它在仓库外 |
| 仓库内 | `layout: inside` | `<repo>\.worktrees\`（`dirName` 可改） | 插件首次创建时把 `# dsh-parallel-worktree` 与 `/.worktrees/` 追加进仓库根 `.gitignore` |
| 自定义后缀 / 目录名 | 改 `siblingSuffix` 或 `dirName` | 按上面两条规则推导 | 同对应行 |

要换落点：改配置里的 `layout`（或 `siblingSuffix` / `dirName`），然后**删掉旧注册表再重建**。注册表里记了创建时的 `layout`，配置与它不一致会报 `LAYOUT_MISMATCH`，提示里直接给出注册表路径和两种解法（改回旧 layout，或删注册表重来）。一个仓库只有一份注册表，所以一个仓库只能选一种布局。

```text
D:\code\portal               # 主仓库
D:\code\portal.wt\            # 默认 wtRoot（仓库外，不进 git）
  registry.json               # 注册表 v1：名字/分支/路径/基线/时间戳
  registry.lock               # 跨进程写锁（短期存在）
  feature\login\              # worktree 检出
  fix\header\
```

名字里的 `/` 会映射成分层目录，所以 `feature/login` → `feature\login`。注册表记录基线提交、创建时间、最近同步/合并信息；`prune` 只清「目录已不存在」的项，不会动活着的 worktree。

`layout: inside` 时注册表就在 `<repo>\.worktrees\registry.json`，会随仓库走；代价是它属于仓库工作树的一部分，团队协作时要确认那行 `.gitignore` 已经提交。

## 与其它 worktree 能力的共存

DSH 里可能同时出现几类 worktree 能力，层次不同，混装前先看清各自注册了什么：

| 能力 | 提供方 | 对外注册 | 检出目录 | 改会话工作目录 | 注册表 |
| --- | --- | --- | --- | --- | --- |
| 本插件 | `dsh-parallel-worktree` | 工具 `worktree_create` / `worktree_list` / `worktree_status`，命令 `/worktree` | 默认仓库外 `<repo>.wt\`，可配 `inside` | 否 | `registry.json` |
| 内置 | `@deepseek-ai/dsh-experimental-tool-worktree`（DSH 自带） | 只有工具 `create_worktree` | 仓库内 `.agents/worktrees\<name>` | 是（建完把会话 cwd 切过去） | 无 |
| 任务级 | `dsh-task-worktree`（第三方） | 也注册 `/worktree`（`mode-on` / `mode-off` / `create` / `list` / `status` / `finish` / `bring-back` / `remove` / `prune`） | 按它自己的约定 | 否 | 每仓库 manifest |
| 视图 | `@cerbur/clutch-dsh-worktree`（第三方） | 只加一个 Worktree 视图（按 worktree 给会话分组） | 不建目录 | 否 | 无 |

**与内置 `create_worktree`：不冲突，可以同时装。** 工具名不同（`create_worktree` vs `worktree_create`）。区别在于：内置工具建完把当前会话的工作目录切到新检出（省一步），检出在仓库内、没有注册表；本插件不改会话目录，靠返回的 `path` 或 `/worktree path` 自己切，换来注册表、仓库外布局、环境引导与收尾闭环。临时开个洞用内置就够，长期并行任务用本插件；两者混用也没问题。

**与 `@cerbur/clutch-dsh-worktree`：不冲突。** 它只做展示层（按 worktree 给会话分组），不创建、不修改 worktree，也没有命令；本插件负责操作层。同时装时，视图里能看到你用本插件建的检出。

**与 `dsh-task-worktree`：会冲突。** 它也注册名为 `worktree` 的斜杠命令，而命令名在 DSH 里全局唯一。两个插件都加载时，后注册的那个抛错并加载失败：

```text
command "worktree" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's `agent.ctx`)
```

症状：`/worktree` 仍然可用，但子命令集与本文档不一致——出现 `mode-on`、`finish`、`bring-back` 之类。排查办法：

1. 打开 **设置 → 插件**，看是否有加载失败/诊断提示；
2. 看 `<profile>/package.json` 的 `dsh.profile.bundles` 顺序——先出现的先注册；
3. 只保留一个：从 bundles 里去掉另一个，或直接卸载它，然后重启。

本机当前状态：`dsh-task-worktree` 装在 `dependencies` 里但**不在** `dsh.profile.bundles`，所以它没有被加载，`/worktree` 属于本插件。

## 常见问题（FAQ）

### 启动报 `cannot resolve profile bundle "dsh-parallel-worktree"` 怎么办？

这是「包文件被 pnpm 当成多余目录删掉了」。profile 是 pnpm 工程，插件管理器跑 `pnpm install` 时，凡是不在 `dependencies` 里的目录都会被清理；老版本把插件装在 `<profile>/node_modules` 里，于是被删掉了。

重跑安装脚本即可（它会装到 `<DSH_HOME>/node_modules`，pnpm 不会碰那里）：

```powershell
node install.mjs --profile desktop --force
```

然后**完全退出并重启** DSH Desktop。想确认装好了，检查：

```powershell
Test-Path "$env:USERPROFILE\.dsh\node_modules\dsh-parallel-worktree\package.json"   # True 才对
```

如果仍想走正规 npm 流程，把包发布/安装成真正的依赖（写进 `dependencies` 并跑 `dsh plugin --profile <名字> install`），这样 pnpm 会把它当自己人。


### 1. 和 DSH 自带的 `create_worktree` 有什么区别？会不会打架

不打架（工具名不同）。内置工具只建检出、建完把当前会话目录切过去、目录在仓库内 `.agents/worktrees/` 且没有注册表；本插件建检出 + 分支 + 注册表，目录默认在仓库外，也不接管会话目录。要「临时开一个洞」用内置够了；要「同时开三四个任务、知道谁脏谁落后、最后合回来」用本插件。

### 2. 我装了别的 worktree 插件，`/worktree` 子命令对不上

见上一节：多个插件注册同名 `worktree` 命令时只有一个生效。先用 `/worktree help` 反查当前生效的是谁的子命令集，然后只保留一个插件，重启。

### 3. 仓库不是 git 仓库，或我在子目录里执行

插件靠 git 定位仓库，必须处于某个 git 工作树内。不是仓库会报 `NOT_GIT_REPO`（提示「请先 git init 或进入已有仓库」）。在仓库的任意子目录执行都可以——它用 `git rev-parse --git-common-dir` 找主仓库根。在已存在的 worktree 里执行同样有效，注册表始终是主仓库那一份，不会变成「每个 worktree 各一份」。

### 4. 同一个分支能开两个 worktree 吗

不能，git 本身也不允许同名分支被两个检出同时持有。对应的三个错误码：

- `BRANCH_EXISTS`：分支已存在 —— 换名字，或先 `git branch -D`；
- `PATH_EXISTS`：目标目录已存在 —— 换名字，或先手动删目录；
- `NAME_EXISTS`：注册表里已有同名项 —— 先 `/worktree remove <name>` 再建。

### 5. 路径含空格、中文、在别的盘符，可以吗

可以。所有 git 调用都走 argv 数组（不经 shell 拼接），空格和中文不会丢。含空格的参数值在斜杠命令里用引号包起来即可（`--message "fix: login redirect"`）。跨盘同样可以建检出；但 `node_modules` 的链接依赖卷/文件系统能力，非 NTFS 或网络盘上可能失败——失败只记进 `warnings`，不会阻塞创建。

### 6. Windows 长路径（>260 字符）报错

git 与 Node 都受 Windows 传统 `MAX_PATH` 限制，表现为 `GIT_FAILED` 且底层是「找不到路径/无法创建文件」。两种解法：

- 把检出根目录放在短路径：默认兄弟目录 `<repo>.wt` 会继承仓库名，仓库本身很深时容易超长；可改 `siblingSuffix` / `dirName`，或直接把仓库放浅（如 `D:\code\portal`）；
- 打开系统长路径支持：组策略 *Computer Configuration → Administrative Templates → System → Filesystem → Enable Win32 long paths*，或注册表 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`，并保持 git 较新版本。

### 7. 用 `--link` 共用 `node_modules` 有什么坑

`--link` 把主仓库的 `node_modules` 链进新检出（Windows 用 junction，无需管理员权限），秒级可用。三个坑：

- **共享**：在任一侧 `npm install` / 改版本，另一侧立刻跟着变，容易出现「主工作区能跑、worktree 里跑不了」；
- **工具兼容**：增量构建、文件 watcher、部分 pnpm 配置对 junction 反应慢或报重复模块；
- **删除顺序**：先删掉链接本身再移除检出（`cmd /c rmdir <检出>\node_modules` 只删链接、不递归内容；不要用会递归的工具直接删），避免删除操作顺着链接走进主仓库。

需要独立依赖时不要 `--link`，在 worktree 内自己装（可先复制主仓库的 lock 文件）。

### 8. `.gitignore` 需要我手工加吗

默认布局（`sibling`）不用，检出在仓库外。只有 `layout: inside` 才需要，而插件首次创建时会自动在仓库根 `.gitignore` 追加：

```text
# dsh-parallel-worktree
/.worktrees/
```

团队协作时把这行提交上去，否则别人会把检出目录看成一堆未跟踪文件。

### 9. profile 目录能搬走或改名吗

不能直接搬。DSH 在 profile 的 `node_modules` 下按包名解析插件，搬走后启动报 `ERR_MODULE_NOT_FOUND`。卸载后重装即可，worktree 数据不受影响（都在仓库里或仓库外，与 profile 无关）。

### 10. 卸载会不会删掉我的 worktree

不会。卸载只删 `<profile>/node_modules/dsh-parallel-worktree` 与 bundles 里的一行。worktree 目录、分支、`registry.json` 都留着，要清理用 `/worktree remove` / `prune` 或手工删。卸载后那些目录仍是正常 git 检出，分支也还在。

### 11. 为什么 AI 不能合并 / 删除，非要我自己敲命令

设计取舍：`merge` 改主分支、`remove` 会丢未提交改动、`prune` 改注册表——这些不可撤销或影响面大，只放在人类命令面；模型侧只有 `create` / `list` / `status`。这样 Agent 不会「顺手」把主分支或你的分支删掉。需要时可以让它把命令写好，你自己执行。

### 12. 为什么创建后会话工作目录没变

本插件不改会话工作目录（内置 `create_worktree` 会改）。拿 `worktree_create` 返回的 `path` 自己切，或先 `/worktree path <name>` 拿到路径再 `cd`。

### 13. `registry.json` 能手工编辑吗

不建议。写入是原子替换 + 文件锁，手工改容易与 git 实际状态不一致（例如目录已删而注册表还在 → `state: missing`，用 `/worktree prune` 修）。JSON 损坏会报 `MANIFEST_CORRUPT`，修法是删掉 `registry.json` 重建（丢掉历史记录，worktree 目录本身不受影响）。

### 14. 一个仓库最多开多少 worktree

git 层面几乎没限制，约束在磁盘与依赖：每个检出都是独立文件树，`node_modules` 不要逐个复制（用 `--link`，或只在需要时安装）。

## 错误码

命令与工具失败时都会给出 `✗ <消息>`，`WorktreeError` 还带一行 `→ 建议`。按场景分类：

| 错误码 | 含义 | 典型处理 |
| --- | --- | --- |
| `NO_CWD` | 拿不到会话工作目录 | 在某个目录里重开会话 |
| `NOT_GIT_REPO` | 不在 git 工作树内 | `git init` 或进入已有仓库 |
| `LAYOUT_MISMATCH` | 注册表的布局与当前配置不一致 | 改回旧 `layout`，或删注册表重建 |
| `NO_REGISTRY` | 该仓库还没有注册表 | 先 `/worktree create <name>` |
| `NAME_REQUIRED` | 缺 `name` | 补上名字 |
| `INVALID_NAME` | 名字不合法（`..`、空格、反斜杠、过长等） | 按规则改名 |
| `INVALID_BRANCH` | 分支名不合法 | 检查 `branchPrefix` |
| `NAME_EXISTS` | 注册表已有同名项 | 先 `remove`，或换名 |
| `PATH_EXISTS` | 目标目录已存在 | 换名或删目录 |
| `BRANCH_EXISTS` | 分支已存在 | 换名，或 `git branch -D` |
| `BASE_NOT_RESOLVED` | 解析不了起点 / 基线 ref | 确认 ref 存在，必要时 `git fetch` |
| `GIT_FAILED` | `git worktree add` 失败 | 看消息里的 stderr（常见是长路径/权限） |
| `WORKTREE_MISSING` | 注册表有、目录已不在 | `/worktree prune` 清理 |
| `WORKTREE_NOT_FOUND` | 名字没注册 | `/worktree list` 看现有名字 |
| `BASE_REQUIRED` | 同步/合并没给基线 | `--base <ref>` 或配置 `baseBranch` |
| `BASE_NOT_CHECKED_OUT` | 主仓库切不到目标基线 | 手动 `git switch <base>` 后重试 |
| `BRANCH_MISSING` | worktree 的分支已不存在 | `/worktree prune` 清理 |
| `DIRTY_MAIN` | 主工作区有未提交改动 | 先提交或 stash |
| `DIRTY_WORKTREE` | worktree 有未提交改动 | `remove` 加 `--force`（会丢弃改动）；`merge` 同步先提交/stash |
| `DETACHED_MAIN` | 主仓库 HEAD 分离 | 先 `git switch <base>` |
| `MERGE_CONFLICT` | rebase/merge 冲突，已自动 abort | 在目标目录手动 rebase/merge 解冲突 |
| `MANIFEST_CORRUPT` | `registry.json` 损坏 | 删掉重建 |
| `LOCK_TIMEOUT` | 另一进程长期持有注册表锁 | 关闭另一个并发操作后重试 |

## 开发与测试

```powershell
node install.mjs --dry-run      # 预检 + 打印安装计划
node --test test/manager.test.mjs test/schema.test.mjs test/tools.test.mjs test/cwd.test.mjs test/commands-json.test.mjs
```

当前 29 项测试：27 通过、0 失败、2 跳过（平台/宿主相关用例），耗时约 110 秒。测试不需要 DSH 桌面进程，纯 Node + 本机 git；会建临时仓库并在结束时清理。工具定义在解析不到宿主 `@deepseek-ai/dsh-tools` 时会降级到 `lib/schema.js` 的本地等价实现（参数校验规则一致，`schema.test.mjs` 覆盖）。

改代码后别忘了同步验证 locale 与图标：`locale/*.json` 必须是合法 JSON 且 `meta.title` / `meta.description` 均为非空字符串（空串会被宿主当成格式错误，整张卡片退化成诊断）。

## 卸载

```powershell
node uninstall.mjs                  # 从默认 profile 卸载
node uninstall.mjs --profile <dir>  # 指定 profile
node uninstall.mjs --dry-run        # 只看计划
```

做两件事：从 `dsh.profile.bundles` 移除 `dsh-parallel-worktree`（`dependencies` 里有也一并移除），删掉 `<profile>/node_modules/dsh-parallel-worktree`；改 `package.json` 前同样备份。**卸载后要重启 DSH。** 卸载不影响任何 worktree 数据。

## 设计取舍

- **收尾动作只给人**：模型侧只有 create/list/status，merge/remove/prune 留在 `/worktree`。不可撤销的操作必须有人确认。
- **检出默认在仓库外**：主工作区永远干净，不用维护 `.gitignore`，`git status` 不被污染。代价是检出不在仓库目录树里（IDE 需要单独打开）——用 `layout: inside` 可以换回来。
- **注册表属于插件，不属于 git**：能记基线、创建时间、最近同步时间，能 prune；代价是可能与 git 实际状态短暂不一致，所以 `list`/`status` 每次都现场探测 `exists` / `dirty` / `ahead` / `behind` 来纠偏。
- **冲突一律自动 abort**：命令必须在无人值守下可预测，冲突留给人手动处理。
- **不接管会话工作目录**：插件保持「纯工具」，目录由用户或 Agent 决定。


