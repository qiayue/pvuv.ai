# 分支、提交与 PR 规范

> English: [`CONVENTIONS.md`](./CONVENTIONS.md)。第 1、2、5 节由 CI（`.github/workflows/pr-check.yml`）自动检查，不符合的 PR 不能合并。

## 1. 分支命名

格式：`<类型>/<简短描述>`，全部小写，单词之间用连字符，总长不超过 50 个字符。

| 类型 | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat/portfolio-overview` |
| `fix` | 修 bug | `fix/cron-daily-batch` |
| `perf` | 性能优化 | `perf/portfolio-batch-query` |
| `refactor` | 重构（行为不变） | `refactor/shared-site-helper` |
| `docs` | 只改文档 | `docs/deploy-integrations` |
| `test` | 只改测试 | `test/crawler-hits-limits` |
| `ci` / `build` | CI、构建、依赖 | `ci/pr-check` |
| `chore` | 杂项维护 | `chore/bump-wrangler` |
| `style` | 只改界面样式 | `style/console-light-theme` |
| `revert` | 回滚 | `revert/portfolio-cache` |
| `release` | 发版 | `release/v0.2.0` |
| `hotfix` | 线上紧急修复（从 `main` 拉，合回 `main`） | `hotfix/ingest-500` |

**不允许：**
- 个人名字、工具名或随机名（`claude/…`、`codex/…`、`yicheng/test`、`dreamy-turing-…`）
- 大写、下划线、空格、中文
- 一个分支混多个不相关的改动

所有分支从最新的 `main` 拉出，合并后删除。

## 2. 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，与仓库现有历史一致：

```
<类型>(<范围>): <一句话摘要>

<可选正文：为什么改、怎么改、有什么影响>

<可选脚注：BREAKING CHANGE: …、Refs #12>
```

- **类型**：同上表（不含 `hotfix`，紧急修复的提交也用 `fix`）。
- **范围**（可选）：`console` `api` `ingest` `consumer` `cron` `proxy` `sdk` `mcp` `cli` `shared` `batch` `funnel` `alerts` `deploy` `deps` `design`。
- **摘要**：用英文祈使句，小写开头，句末不加句号，不超过 72 个字符。例如 `fix(cron): run the daily batch from the hourly job when its schedule stops firing`。
- **不兼容改动**：在类型后加 `!`（如 `feat(api)!: …`），并在脚注写 `BREAKING CHANGE: 说明 + 升级方法`。
- 一个提交只做一件事；格式化之类的大改动单独提交。

## 3. PR 规则

1. **标题** = 一条合规的提交头，例如 `feat(console): portfolio overview for many sites`。合并时用 squash，标题就是 `main` 上最终的提交信息。
2. **先开草稿（Draft）**，自测通过、模板填完后再转为 Ready for review。
3. **一个 PR 只解决一个问题**。建议 diff 控制在 800 行以内（不计锁文件、截图、生成文件）；超过的要在描述里说明为什么不能拆。
4. **按模板填写**（`.github/pull_request_template.md`）：改了什么、为什么、怎么测的、截图、迁移和部署步骤、风险和回滚方式。
5. **必须通过 CI**：分支名、PR 标题、`npm run typecheck`、`npm test`。
6. **数据库**：改了表结构就要新增编号连续的迁移文件 `migrations/00NN_*.sql`，同步更新 `shared/schema.sql` 和 `PROJECT_PLAN.md` 对应章节。迁移只能新增，已合并的迁移文件不能修改。
7. **文档和变更日志**：用户能感知的改动，要在 `CHANGELOG.md` 的 `## [Unreleased]` 下加一行；接口或行为变了，要同步更新 README / DEPLOY / `docs/API.md`，中英文都要改。
8. **界面改动**：7 种语言的文案都要补齐，并附改动前后的截图，截图放在 `docs/design/screens/`。
9. **安全**：不能提交密钥、真实账号 ID 或 `.dev.vars`；代码、文档、提交信息里不能出现私有接入方的项目名。
10. **合并**：至少 1 人 review 通过、CI 全绿、没有未解决的评论之后，用 **Squash and merge** 合并，然后删除分支。多人协作的大功能可以先合到 `feat/…` 汇总分支，再整体提一个 PR 合进 `main`，这种情况允许用 merge commit。

## 4. 大功能的拆分方式

需要多个人或多个子任务并行开发时：

- 先建汇总分支 `feat/<功能名>` 并开草稿 PR 合进 `main`。
- 每个子任务从汇总分支拉出 `feat/<功能名>-<子模块>`，开 PR 合进汇总分支，不直接合进 `main`。
- 先在 `docs/design/` 写好共享约定（接口格式、文件归属、迁移编号段），再并行开发。

## 5. 自动检查一览

| 检查项 | 规则 |
|---|---|
| 分支名 | `^(feat\|fix\|perf\|refactor\|docs\|test\|ci\|build\|chore\|style\|revert\|release\|hotfix)/[a-z0-9]+(-[a-z0-9]+)*$`，≤ 50 字符；`dependabot/…` 除外 |
| PR 标题 | `^(feat\|fix\|perf\|refactor\|docs\|test\|ci\|build\|chore\|style\|revert\|release)(\([a-z0-9-]+\))?!?: .+`，≤ 100 字符 |
| 代码 | `npm ci` → `npm run typecheck` → `npm test`（Node 22） |
