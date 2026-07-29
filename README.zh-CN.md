# pvuv.ai

**注重隐私的网站统计,内置无效流量识别与广告防护。可以直接用官方托管服务,也可以完全自己部署在 Cloudflare 上。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](#路线图)
[![Runs on Cloudflare](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)

> English: [`README.md`](./README.md) · 完整构建规格：[`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)

pvuv.ai 是一个跑在 Cloudflare 边缘的轻量统计平台。它不只统计 PV/UV,还会给每一次访问打真实性分数,识别只有在聚合层面才会暴露的无效流量,并且可以在判定流量可信时才加载广告代码——帮助保护广告账号免受无效流量牵连。

## 两种使用方式

**拿不准?先用托管版。** 之后随时可以转成自部署——是同一个产品,唯一要改的只是站点上的那段代码。

| | **托管版 —— [pvuv.ai](https://pvuv.ai)** | **自部署 —— 本仓库** |
|---|---|---|
| 怎么开始 | 谷歌登录,贴上代码 | 4 条命令,约 10 分钟 |
| 需要准备 | 无 | Cloudflare 账号(Workers 付费版 $5/月)+ 一个已托管在上面的域名 |
| 升级与运维 | 我们负责 | 你自己 `git pull` 后重新部署 |
| 数据在哪 | 在我们的服务器上 | **只在你自己的 Cloudflare 账号里**,不经过任何第三方 |
| 调整检测策略 | 使用产品默认值 | 每一个信号权重和阈值都可以自己改 |
| 许可协议 | —— | MIT:随便用、随便改、可商用,没有附加条件 |

→ **托管版:** 打开 [pvuv.ai](https://pvuv.ai) 用谷歌登录即可,本文其余部分可以跳过。
→ **自部署:** 继续往下读,然后从[开始之前](#开始之前)入手。

> **状态**：本仓库正在积极开发中。[路线图](#路线图)跟踪首个可部署里程碑（M1）的进度。正式打 tag 前，接口与表结构可能变动。

---

## 为什么做这个

多数自托管统计工具只数流量、把每个请求都当真人。靠广告变现的站点，面对说不清来源的虚假流量往往措手不及。pvuv.ai 把**流量质量当作一等指标**：在常规统计之外多采一层真实性信号，让你能区分干净流量与 bot、看清坏流量来自哪里、并据此行动。

## 功能

**全维度统计**
- 多站点、多子域，per-page PV/UV
- 来源、完整 UTM，以及全部点击/跟踪参数（gclid、fbclid、ttclid、msclkid、ref…）
- 跳出率（基于互动、GA4 口径）与真实停留时长
- 含金额的自定义事件（自动折算 USD）
- 会话级与用户级全链路归因（首触 + 末触），跨设备身份合并

**虚假流量识别（三层）**
- **前端信号** —— 无头/自动化特征、环境矛盾、WebGL/canvas、蜜罐
- **会话特征** —— 页间时序、路径模式、是否有交互
- **群体统计** —— 指纹 / IP 段聚簇、分布形态检验、时序规律性、基线异动，以及跨站识别
- 每条事件都带 0–100 分、判定（`clean`/`suspect`/`bot`/`crawler`）、以及命中信号的位标记

**广告防护（可选）**
- 渐进式判定：首页快速决策，第二页起精准拦截
- 只给可信流量加载广告代码；**绝不修改广告脚本本身**（只决定是否注入）
- 默认 fail-open —— 任何异常都默认加载广告，绝不误伤收入
- 阈值由站长自己控制，提供影子（只记录不拦截）模式，先看影响再启用

**AI 分析（可选）**
- 定时与按需报告：*数据异动 → 归因判断 → 可执行建议*

**默认开放**
- 只读 REST API、让你自己的 Chatbot 查询流量的 **MCP 服务器**、以及 **CLI**——三者共用同一个可限权、可吊销的令牌（[`docs/API.md`](./docs/API.md)）
- 控制台支持 7 种语言（English、中文、日本語、한국어、Deutsch、Français、Español），前端即时切换
- 一键导出仪表盘展示的全部数据（JSON）
- 可选的爬虫分类（搜索引擎 / AI 训练 / SEO / 广告验证），来自导入的公开爬虫目录

## 架构

```
浏览器 (f.js)
  → in.pvuv.ai/in   ingest Worker：校验 + 服务端补全 + 实时打分
  → Cloudflare Queue
  → consumer Worker：批量写 D1 events，更新 sessions/画像
  → Cron（每小时）   rollup 预聚合表
  → Cron（每天）     群体分析 → 改判 + KV 黑名单 ──┐
                                                    │ 闭环回
  api.pvuv.ai/v1    查询 API（后台 / 排名 / AI）    │
  pvuv.ai           控制台（看板、流量质量）  in.pvuv.ai/v ←┘ 快速判定
```

**域名分离** —— 会嵌到被统计站点上的暴露子域（`js`、`in`）与内部子域（`api`、主域后台）隔离，暴露子域即使某天进了拦截列表，后台和查询也不受影响。详见 [`PROJECT_PLAN.zh-CN.md` §1](./PROJECT_PLAN.zh-CN.md)。

## 技术栈

Cloudflare **Workers**（ingest、consumer、api、console、cron）· **D1**（SQLite，事件按月分表）· **Queues**（削峰）· **KV**（黑名单、配置缓存）· **Cron Triggers**（聚合、批量分析）· 可选 **R2**（归档/静态）。无外部数据库，无需自己运维服务器。

## 开始之前

自部署需要三样东西。**请现在就把三条都确认一遍**——第三条是最容易踩坑的,
在这里发现比装到一半才发现要好得多:

- [ ] 本机装有 **Node.js 18+**
- [ ] **域名已经添加到 Cloudflare**(任意套餐即可)。不需要把网站搬过去,
      只要域名的 DNS 托管在 Cloudflare 就行
- [ ] **Workers 付费套餐 —— 每月 $5**。这条无法绕过:数据接收链路用到了
      Cloudflare Queues,免费套餐不包含它

其余的一切——数据库、KV、队列、DNS 记录、TLS 证书——都会自动创建。

> 只是想先试试?[托管版](https://pvuv.ai)这三样都不需要。

## 安装

**完整分步教程：[`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md)**（English: [`DEPLOY.md`](./DEPLOY.md)）。简版：

```bash
git clone https://github.com/qiayue/pvuv.ai.git && cd pvuv.ai
npm install
npx wrangler login
npm run setup
```

`npm run setup`会完成其余全部工作:创建 D1 数据库、KV 命名空间和队列,填好所有配置占位符,把路由指向你的域名,应用数据库迁移,构建 SDK 并部署全部 5 个 worker。**可以重复运行**——已完成的步骤会跳过,已配置好的文件不会被覆盖。先加 `--dry-run` 可以完整预览它将要做什么。

域名只在开头询问一次,随后自动写入所有需要的位置。DNS 记录与证书由 Cloudflare 自定义域自动签发,所以**唯一无法自动化**的只剩创建 Google/GitHub OAuth 应用(控制台仅支持 OAuth 登录)。脚本最后会打印这一步,并已填好你的回调 URL;[`DEPLOY.md`](./DEPLOY.md) 有分步说明。

前提:域名需已添加到你的 Cloudflare 账号,且各主机名未被占用——worker 会完整接管它所属的主机名。

非交互方式(CI、脚本化安装):

```bash
npm run setup -- --domain example.com --admin you@example.com
```

然后在控制台域名登录、注册站点、把生成的嵌入代码贴到你的网站。DNS 配置、验证步骤和排障：[`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md)。

## 接入一个站点

在控制台注册站点拿到 `site_id`，然后嵌入：

```html
<script defer src="https://js.pvuv.ai/f.js"
        data-site="YOUR_SITE_ID"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

可选属性：`data-spa="true"`（SPA 路由追踪）、`data-api`（上报地址覆盖 / 自建反代，见 [`PROJECT_PLAN.zh-CN.md` §12](./PROJECT_PLAN.zh-CN.md)）、`data-exclude="/admin/*"`、`data-sensors="off"`（关闭移动端传感器信号，供合规）。

> **自部署必须设置 `data-api`** 指向你自己的上报域名（如 `data-api="https://in.example.com"`）——SDK 内置默认值是参考域名。控制台生成的嵌入代码会自动带上适配你部署的值。

## 上手第一周

广告防护**默认是关闭的**,这是刻意设计。误拦真人的广告是真金白银的损失,
所以产品的思路是:先看清楚,再决定拦不拦。

**第 1 天 —— 确认数据进来了。** 打开控制台点「Self-check」,然后一边访问自己的
页面,一边看站点面板里的实时那一行。

**第 1–7 天 —— 只看,不动。** 在改任何设置之前,先摸清**你自己站点**的正常水位:

- **流量质量**面板显示 clean / suspect / bot / crawler 的构成,以及到底是哪些
  检测信号被触发了。
- **流量健康条**显示每个受监控的比例,以及它离告警线还有多远——数字在爬升时
  你能提前看到,而不是等它出事。
- 图表下方的**异常流量色带**告诉你坏流量是**一次性爆发**还是**全天弥漫**,
  这两者的应对方式完全不同。

**第 2 周 —— 预演广告防护会拦掉什么。**「广告防护」面板会按档位估算:会拦掉多少
浏览量、以及由此产生的误伤率——全部基于**你自己**已记录的流量。**不需要改任何
设置**就能看到,只要有数据就可以看。

**然后再启用。** 挑一个你能接受的误伤率档位——通常是 `balanced`——打开即可。
任何时候都可以改回 `off`。

> **影子模式**是针对另一种操作顺序的保护:如果你在**建站时就开启了防护**,
> 它会在最初 `adguard.shadow_days` 天(默认 7 天)照常出广告、只记录判定,
> 之后才开始真正拦截。建站时选了 `off` 的站点没有东西可影子——用上面的面板
> 估算即可。

跑起来之后可以做的事:创建 **API 令牌**,用 Chatbot 或 CLI 查询自己的数据
([`docs/API.md`](./docs/API.md));如果你的流量有默认值判不准的特点,在
`config.local.toml` 里调整信号权重。

## 配置

评分权重、判定阈值、黑名单都是**可调且部署私有**的。`config.example.toml` 提供示例默认值；复制为 `config.local.toml`（已 gitignore）自行私有调优。引擎从 config 读取权重、代码不硬编码，因此可以在不暴露给刷手的前提下调整检测。详见 [`PROJECT_PLAN.zh-CN.md` §21](./PROJECT_PLAN.zh-CN.md)。

## API、MCP 服务器与 CLI

随处读取你的数据:面向集成的 REST API、让你自己的 Chatbot 回答流量问题的 **MCP 服务器**,以及适合终端和定时任务的 **CLI**。三者均为只读,共用同一套凭证。

在控制台(⚙ → API 令牌)创建个人 API 令牌——可限定到单个站点或全部站点,可单独吊销,仅以 HMAC 形式存储。

```bash
export PVUV_API_URL=https://api.pvuv.ai
export PVUV_TOKEN=pvuv_…

curl -H "Authorization: Bearer $PVUV_TOKEN" "$PVUV_API_URL/v1/sites"
node cli/pvuv.mjs overview <site_id> --period 7d
```

MCP 服务器和 CLI 都是零依赖单文件,不会在持有令牌的地方引入额外依赖。完整说明见 [`docs/API.md`](./docs/API.md)。

## 外部排名 API（可选）

外部排名/评分系统可以用服务端 API token 一次拉取跨站点、基于清洗流量的榜单：

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "https://api.pvuv.ai/v1/ranking?period=30d"
```

返回每个活跃站点的 clean（已排除 bot/crawler/suspect）浏览量，并拆分为**内部**（本部署内另一站点带来的互访）与**外部**流量。默认 `score` 用的是外部 clean 浏览量——所以你自己站点之间的互访不会抬高排名；所有字段都暴露出来，外部系统可自行套用公式。站长也能在 console 里看到「Site ranking」表格。详见 [`PROJECT_PLAN.zh-CN.md` §14](./PROJECT_PLAN.zh-CN.md)。

## 版本（开放内核）

pvuv.ai 采用**开放内核（open core）**模式——两者怎么选见[两种使用方式](#两种使用方式)：

- **本仓库——自托管版——采用 MIT 许可**。随便用、随便改、可商用、可闭源集成进你自己的产品。没有 copyleft、没有署名要求、没有任何附加条件。**无所顾忌地用。**
- **托管的多租户 SaaS 版**（托管账号、计费、组织隔离、技术支持）由作者单独提供，**不在本仓库内**。两者不重叠、不冲突——开源版本身就是完整可用的。

## 署名（可选）

自带的默认首页页脚有一个小小的「Powered by pvuv.ai」链接指回项目——**仅出现在部署实例自己的首页**（后台和内页没有链接，也绝不会向被统计的网站注入任何内容）。这只是个**善意的默认，不是义务**：MIT 不作任何强制。你想支持项目就留着，不想要就随手删掉——放一个你自己的 `workers/console/public/home.html`（原样输出、不再追加任何页脚），或直接改默认页即可。当然，来 GitHub 点个 star 我们会很开心。🙏

> 默认首页刻意做得非常简单——它*就是*为了让你自定义的。成千上万个部署共用同一套落地页文案，只会在搜索引擎里制造重复内容。

## 隐私与合规

pvuv.ai 以数据最小化为设计原则：
- IP 只存截断哈希（+ /24 段哈希），不存明文。
- 设备指纹只存哈希与结论、不存原始值，仅用于真实性打分，不做跨站访客画像。
- 移动端传感器信号只是粗粒度布尔值（不采原始流、不做传感器指纹），可关闭。

**部署者责任**：在 GDPR/ePrivacy 辖区，指纹与传感器信号可能需要用户同意。项目提供数据最小化默认与关闭开关；各部署者需对自身法域的合规负责。详见 [`PROJECT_PLAN.zh-CN.md` §16](./PROJECT_PLAN.zh-CN.md)。

## 路线图

| 里程碑 | 范围 |
|---|---|
| **M1**（首个可部署） | SDK + 上报 + 快速判定 + D1 表 + 最简控制台（PV/UV、来源、Top 页、流量质量概览） |
| **M2** | 会话/停留/跳出、完整 UTM、rollup 加速、群体分析 + 黑名单闭环、影子模式、反代方案 |
| **M3** | identify + 自定义事件 + revenue + 漏斗归因、分布检验 + 基线异动 |
| **M4** | AI 报告、完整反作弊、外部排名对接、人工复核界面 |

完整细节见 [`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)。

## 参与贡献

欢迎贡献 —— 见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。提议前请先读构建规格，确保方案契合架构。

## 安全

发现漏洞？请私下上报 —— 见 [`SECURITY.md`](./SECURITY.md)。安全问题请勿开公开 issue。

## 许可证

[MIT](./LICENSE)。想怎么用就怎么用——自托管、修改、再分发、商用都行，不必开源你的改动，也没有署名要求。作者单独提供的托管多租户 SaaS 版按其自身条款授权，不在本仓库覆盖范围内。
