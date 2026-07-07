# pvuv.ai 部署到 Cloudflare 指南

> English version: [`DEPLOY.md`](./DEPLOY.md)

本指南带你从克隆仓库到完整可用的部署：五个 Worker、一个 D1 数据库、两个 KV
命名空间、一个 Queue，以及采集 SDK。所有命令都与仓库当前的 `wrangler.toml`
逐一对应。

**部署完成后的形态**（地址是示例，换成你自己的域名）：

| 组件 | 地址 | Worker |
|---|---|---|
| 上报 + 快速判定 | `https://in.example.com/in`、`/v` | `workers/ingest` |
| 队列消费者 | （无路由——消费 `pvuv-ingest`） | `workers/consumer` |
| 查询 API | `https://api.example.com/v1/...` | `workers/api` |
| 控制台（后台） | `https://example.com/` | `workers/console` |
| 定时聚合 | （无路由——Cron 触发） | `workers/cron` |
| SDK `f.js` | `https://example.com/f.js`（M1 方案，见第 8 步） | 由 console 托管 |

---

## 0. 前置条件

- **Cloudflare 账号**，且开通 **Workers Paid 套餐**（$5/月）——上报管道用了
  [Cloudflare Queues](https://developers.cloudflare.com/queues/)，免费套餐没有。
  D1、KV、Workers 本身的用量对中小站点来说包含额度足够。
- 一个**已接入 Cloudflare 的域名**（DNS zone 在你的账号下），用于绑定
  `in.<域名>`、`api.<域名>` 和控制台主机。
- **Node.js 18+** 和 npm。
- 登录一次：`npx wrangler login`，然后用 `npx wrangler whoami` 记下 account id。

## 1. 克隆并安装

```bash
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install     # postinstall 会从 config.example.toml 生成 shared/config.gen.ts
```

## 2.（可选但推荐）私有打分配置

权重/阈值全部从配置读取，代码里没有硬编码。仓库只带示例默认值，生产调参放在
gitignore 的私有文件里：

```bash
cp config.example.toml config.local.toml   # 已 gitignore，放心调
npm run config:gen                          # 每次改完重新生成
```

跳过这步就用示例默认值。`config:gen` 在 `npm install` 和 SDK 构建前都会自动跑。

## 3. 创建 Cloudflare 资源

```bash
npx wrangler d1 create pvuv-db                 # 记下输出的 database_id
npx wrangler kv namespace create BLOCKLIST     # 记下 id
npx wrangler kv namespace create SITE_CONFIG   # 记下 id
npx wrangler queues create pvuv-ingest
npx wrangler queues create pvuv-ingest-dlq     # 死信队列
```

## 4. 替换占位符

所有 `wrangler.toml` 里都是 `PLACEHOLDER_*` 占位值，用第 3 步的真实 id 替换
（在仓库根目录执行）：

```bash
ACCOUNT_ID=...        # 来自 `npx wrangler whoami`
D1_ID=...             # 来自 `wrangler d1 create`
KV_BLOCKLIST_ID=...   # 来自 `wrangler kv namespace create BLOCKLIST`
KV_SITE_CONFIG_ID=... # 来自 `wrangler kv namespace create SITE_CONFIG`

sed -i "s/PLACEHOLDER_ACCOUNT_ID/$ACCOUNT_ID/" wrangler.toml workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_D1_DATABASE_ID/$D1_ID/" wrangler.toml workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_KV_BLOCKLIST_ID/$KV_BLOCKLIST_ID/" workers/*/wrangler.toml
sed -i "s/PLACEHOLDER_KV_SITE_CONFIG_ID/$KV_SITE_CONFIG_ID/" workers/*/wrangler.toml
```

> **不要把真实 id 提交回公开仓库/公开 fork。** 这些不算密钥，但项目约定
> （PROJECT_PLAN §21–§22）要求它们不进仓库。建议用私有克隆部署，或本地改动
> 不提交。

## 5. 改成你的域名

路由默认写的是 `pvuv.ai`，改成你自己的 zone：

- `workers/ingest/wrangler.toml` → `pattern = "in.example.com/*", zone_name = "example.com"`
- `workers/api/wrangler.toml` → `pattern = "api.example.com/*", zone_name = "example.com"`
- `workers/console/wrangler.toml` → `pattern = "example.com/*", zone_name = "example.com"`
  （也可以用 `console.example.com/*` 这样的子域，但需要相应调整嵌入代码里的
  `data-api`，见第 9 步）
- `workers/console/wrangler.toml` 的 `[vars] ADMIN_EMAIL` → 你的登录邮箱。

路由只对经过 Cloudflare 代理的主机名生效。如果 `in.`、`api.` 还没有 DNS 记录，
在 Cloudflare DNS 面板加占位记录：类型 `AAAA`、名称 `in`（以及 `api`）、内容
`100::`、代理状态**开启**（橙色云朵）。

## 6. 建库表

```bash
npm run db:migrate:remote     # 即 wrangler d1 migrations apply pvuv-db --remote
```

这会创建 `shared/schema.sql` 里的全部表（含 M2+ 占位表）。之后每个月的
`events_YYYYMM` 分表由 consumer 自动创建，无需手动操作。

## 7. 部署 Worker，然后设置密钥

```bash
npm run deploy:all
```

然后设置密钥。**三个 Worker 必须用同一个 `HMAC_KEY`**——console 签发的会话
cookie 要由 api 验证，ingest 签发 `_pv_v` 判定 cookie：

```bash
openssl rand -base64 32        # 生成一个密钥，下面三处复用同一个值

npx wrangler secret put HMAC_KEY       -c workers/ingest/wrangler.toml
npx wrangler secret put HMAC_KEY       -c workers/api/wrangler.toml
npx wrangler secret put HMAC_KEY       -c workers/console/wrangler.toml
npx wrangler secret put API_TOKEN      -c workers/api/wrangler.toml      # 外部系统服务端调 API 用
npx wrangler secret put ADMIN_PASSWORD -c workers/console/wrangler.toml  # 控制台登录密码
```

密钥即时生效，不用重新部署。`HMAC_KEY` 没设置之前，`/in` 和 `/v` 会刻意返回
500，而不是带着空密钥运行。

## 8. 构建并托管 SDK

```bash
npm run build:sdk                                   # → sdk/dist/f.js（gzip 后约 3 KB）
cp sdk/dist/f.js workers/console/public/f.js
npm run deploy:console
```

现在 `f.js` 在 `https://example.com/f.js` 可访问。

> **说明（M1）。** 参考架构把 SDK 放在独立的 `js.` 子域，这样即使暴露域名进了
> 拦截列表也不影响后台（PROJECT_PLAN §1）。从 console 主域直接服务是 M1 的
> 简化方案；以后迁到 `js.<域名>`（Workers Static Assets 或 R2）或第一方反代
> （§12）不需要改代码。

## 9. 注册第一个站点

1. 打开 `https://example.com/login.html`，用 `ADMIN_EMAIL` + `ADMIN_PASSWORD` 登录。
2. 在 **Add a site** 填：站点名、被统计站点的域名（如
   `blog.example.org, www.blog.example.org`）、adguard 模式、可选的 AdSense id。
3. 复制生成的嵌入代码，形如：

```html
<script defer src="https://example.com/f.js"
        data-site="Ab3xK9pQ"
        data-api="https://in.example.com"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

`data-api` 必须指向你的上报域名——SDK 内置默认值是参考域名 `in.pvuv.ai`，所以
自部署**务必带上 `data-api`**（console 会按你的控制台域名自动生成，若你的
上报域名不同请手动调整）。

## 10. 验证

**最简单:用内置的自检工具。** 登录控制台点顶部 **Self-check**,或直接访问
`https://<你的控制台域名>/health.html`。它会逐项走一遍:数据库、迁移、密钥、
配置、KV、上报端点、一次真实的端到端测试事件(上报 → Queue → consumer → D1,
含服务端补全 + 打分)、以及 `/v` 快速判定,任何一项失败都会告诉你具体怎么修。
它用一个隐藏的 `__pvuv_selftest` 站点,不会污染你的真实统计数据。

或者手动检查:

```bash
# ingest 是否存活（空 body 返回 400 "bad json" = Worker 正常、可达）：
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://in.example.com/in
# 带 body 但 Origin 是外域会返回 204（事件被静默丢弃）；
# 完全没有 Origin/Referer 头则返回 403

# 访问站点的同时看实时日志：
npx wrangler tail -c workers/ingest/wrangler.toml
npx wrangler tail -c workers/consumer/wrangler.toml
```

然后访问一个已嵌入代码的页面，在浏览器开发者工具里确认 `POST /in` 返回 **204**。
数据出现的时间线：

- **立即**：console 的 High-score traffic 钻取列表能看到事件（它直接读原始事件表）。
- **一小时内**：指标卡/趋势图/各维度表填充——它们读预聚合表，cron 每小时
  `:05` 重算。

## 可选:Google / GitHub 登录

控制台支持密码登录(仅站主),以及可选的 Google、GitHub 社交登录。某个渠道只有
在其 client id 和 secret 都设置后,才会出现在登录页。

**访问由邮箱白名单控制**——OAuth 是身份认证,不是开放注册。`ADMIN_EMAIL` 永远
允许;其他人加进 `workers/console/wrangler.toml` 的 `ALLOWED_EMAILS`(逗号分隔)。
身份以验证过的邮箱为准,所以同一邮箱用 Google 或 GitHub 登录是同一个账号;
`ADMIN_EMAIL` 映射到站主及其已建站点。

**Google:** 在 [Google Cloud Console](https://console.cloud.google.com/) →
API 和服务 → 凭据,创建 OAuth 客户端(类型:Web 应用),授权重定向 URI 填
`https://<你的控制台域名>/api/auth/google/callback`。然后:

```bash
# 在 workers/console/wrangler.toml 的 [vars] 里设置 GOOGLE_CLIENT_ID,然后:
npx wrangler secret put GOOGLE_CLIENT_SECRET -c workers/console/wrangler.toml
npm run deploy:console
```

**GitHub:** 在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth
App,Authorization callback URL 填
`https://<你的控制台域名>/api/auth/github/callback`。然后:

```bash
# 在 workers/console/wrangler.toml 的 [vars] 里设置 GITHUB_CLIENT_ID,然后:
npx wrangler secret put GITHUB_CLIENT_SECRET -c workers/console/wrangler.toml
npm run deploy:console
```

改了 `[vars]` 后要重新部署 console;密钥即时生效。

## 自定义首页

部署后的 `/` 是一个公开落地页。三个层级，都不需要 fork 代码：

1. **改名称 + 介绍（零代码）。** 登录 console → *Homepage settings*：填你的
   网站名称和介绍，默认首页会服务端渲染它们（包括 `<title>` 和
   `<meta name="description">`）。
2. **完全自定义页面。** 新建 `workers/console/public/home.html`，写任意 HTML，
   重新部署 console——它会整页替换默认首页。该文件已 **gitignore**，你的落地页
   文案永远不会进公开仓库，`git pull` 也不会冲突。官方 pvuv.ai 首页就按这个
   方式做。署名页脚由 Worker **自动追加**到页面末尾——你不需要（也不应）自己
   写进 HTML。
3. **默认。** 什么都不做，就是自带的极简页面。

无论用哪一层，首页都会带页脚的两个署名链接（pvuv.ai + GitHub）；免费部署需
保留它们，见 README「署名」。默认页刻意极简，是为了避免成千上万个部署发布一模一样的
落地页文案（搜索引擎重复内容）。

## 常见问题排查

| 现象 | 大概率原因 |
|---|---|
| `/in` 返回 500 | ingest 的 `HMAC_KEY` 密钥没设置 |
| `/in` 返回 204 但没数据 | 页面 `Origin` 与站点 `allowed_domains` 不匹配（按设计静默丢弃）——检查注册的域名；站点信息修改后 KV 缓存最多 5 分钟刷新 |
| `/in` 返回 403 | 请求没有 `Origin`/`Referer` 头（服务器直发会被拒） |
| 指标卡空但钻取有数据 | rollup 每小时 `:05` 跑——等下一轮 |
| 控制台登录失败 | `ADMIN_PASSWORD` 密钥或 `ADMIN_EMAIL` 变量不匹配 |
| API 返回 401 | 缺少/错误的 `Authorization: Bearer <API_TOKEN>` 或 console 会话 cookie |
| 部署时 Queue 报错 | Queues 需要 Workers Paid 套餐；`pvuv-ingest` 和 `pvuv-ingest-dlq` 都要先建好 |

## 本地开发

不需要任何 Cloudflare 资源，全部跑在 miniflare 里：

```bash
npm install
npx wrangler d1 migrations apply pvuv-db --local --persist-to .wrangler/dev

# 造一个测试站点（走 console 建站也行）：
npx wrangler d1 execute pvuv-db --local --persist-to .wrangler/dev --command \
  "INSERT INTO sites (site_id,name,owner_id,allowed_domains,adguard_mode,created_at)
   VALUES ('Ab3xK9pQ','dev','admin','[\"localhost\"]','balanced',0)"

# ingest + consumer 放在同一个 dev 会话里才共享本地队列：
npx wrangler dev -c workers/ingest/wrangler.toml -c workers/consumer/wrangler.toml \
  --persist-to .wrangler/dev --port 8788 --var HMAC_KEY:dev-key

# console（可以开另一个终端——但同一 persist 目录不要同时跑多个 dev 会话）：
npx wrangler dev -c workers/console/wrangler.toml --persist-to .wrangler/dev \
  --port 8790 --var HMAC_KEY:dev-key --var ADMIN_PASSWORD:dev-pass

# 本地触发每小时 rollup：
npx wrangler dev -c workers/cron/wrangler.toml --persist-to .wrangler/dev \
  --port 8791 --test-scheduled
curl "http://localhost:8791/__scheduled?cron=5+*+*+*+*"
```

测试页面的嵌入代码里写 `data-api="http://localhost:8788"`。

## 更新已有部署

```bash
git pull
npm install                   # 重新生成 config.gen.ts
npm run db:migrate:remote     # 应用新迁移（没有就是空操作）
npm run build:sdk && cp sdk/dist/f.js workers/console/public/f.js
npm run deploy:all
```
