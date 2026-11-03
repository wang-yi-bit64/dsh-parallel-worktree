# Releasing dsh-parallel-worktree

## 1. 发布到 npm（首次）

需要在一台能访问 `https://registry.npmjs.org` 的机器上操作，或让 GitHub Actions 代发。

### A. 本地发布

```powershell
cd D:\path\to\dsh-parallel-worktree
npm login                      # 输入 npm 账号
npm publish --access public    # 会先跑 npm pack，上传 20 个文件
```

### B. 由 GitHub Actions 发布（推荐：Trusted Publishing）

npm 对「长期 token」有安全警告（“There are security risks with this option. For automation or CI/CD uses, please use Trusted Publishing instead.”）。Trusted Publishing 用 GitHub 的 OIDC 短期凭证代替长期 token：工作流里不需要保存任何 npm 密钥，npm 直接校验「这个仓库的、这个 workflow 文件的、这个 environment 的」运行。

**首次发布（bootstrap）**：包还不存在于 npm 时，npm 的包设置页无法配置 trusted publisher，所以第一次必须用 token 发：
1. 生成一个 **Automation** classic token（或 Granular token 勾 Bypass 2FA + Packages: Read and write + All packages）。
2. 保存为 secret（仓库级 `NPM_KEY`，或环境 `NPM_KEY` 下的 `NPM_KEY`）。
3. 跑本 workflow，得到 `dsh-parallel-worktree@0.2.0`。

**之后切到 Trusted Publishing（建议立刻做）**：
1. npmjs.com → 该包 → Settings → **Trusted publishing** → Add a trusted publisher，填：Repository `wang-yi-bit64/dsh-parallel-worktree`、Workflow filename `publish.yml`、Environment `NPM_KEY`（与 workflow 里的 `environment:` 一致；如不想用环境，把 workflow 里这一行也删掉，保持一致即可）。
2. 删掉仓库/环境里的 `NPM_KEY` secret。
3. 再跑 workflow：日志会打印 `Mode: Trusted Publishing (OIDC, no stored token)`，不需要 OTP 也不需要 token。
4. 之后所有版本都用 tag（`v0.2.1`…）或 Run workflow 发布即可。

### B2. 用 token 发布（备用，非首选）

1. 在 npmjs.com → Access Tokens → Generate New Token 选择 **Automation**，复制 token。
2. 二选一保存 token：
   - **环境 secret（workflow 已按这个配置）**：Settings → Environments → 新建/选择环境 `NPM_KEY` → Add environment secret，名字 `NPM_KEY`；job 里已声明 `environment: NPM_KEY`。
   - **仓库 secret**：Settings → Secrets and variables → Actions → New repository secret，名字 `NPM_TOKEN`（workflow 会回退到它）。
3. 触发 `Publish to npm` 工作流：
   - Actions 页面 → **Publish to npm** → **Run workflow**，或
   - `gh workflow run "Publish to npm" --repo wang-yi-bit64/dsh-parallel-worktree`，或
   - 推一个新 tag：`git tag v0.2.1 && git push origin v0.2.1`（tag 必须匹配 `v*`）。
4. 工作流里 `npm publish --provenance --access public`，发布后 npm 包页会出现「Built and signed on GitHub Actions」的 provenance 标记。

## 2. 后续版本

1. 改 `package.json` 的 `version`（语义化版本）。
2. 同步更新 `README.md` / `README.en.md` 的变更说明。
3. 本地跑 `npm test`（29 用例，2 个 skip 是宿主 dsh-tools 无法在裸 node 下解析的编译用例）。
4. 提交、推 tag（`v0.2.1` 之类）→ 自动发布；或手动 Run workflow。
5. 可选：`gh release create v0.2.1 dsh-parallel-worktree-0.2.1.tgz --target main --notes "..."`，同时把 tarball 作为 release 资源，界面里可直接用 URL 安装。

## 3. 包名冲突时

若 npm 返回 403「You do not have permission to publish "dsh-parallel-worktree"」（名字已被占用），改用 scoped 名：

1. `package.json` 的 `name` 改成 `@<npm 用户名>/dsh-parallel-worktree`。
2. `cordis.patch.yml` 的 `name:` 同步改。
3. `client/client.js` 里 `window.__ModuleLoader__.load({ id: '...' })` 的 id 同步改（模块身份 = 包名）。
4. `version` 加一（如 0.2.1），重新 `npm publish --access public`。

## 4. 发布后的验证

```powershell
npm view dsh-parallel-worktree version dist-tags.latest
npm pack dsh-parallel-worktree --dry-run
```

在 DSH 侧栏「插件」→「添加插件」里输入包名 `dsh-parallel-worktree`（或 scoped 名）即可安装；之后详情页的「更新」会在你发布新版本后可用。
