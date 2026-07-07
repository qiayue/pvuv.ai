# pvuv.ai

**自托管、隐私友好的网站统计，内置虚假流量识别与广告防护 —— 跑在 Cloudflare Workers + D1 上。**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Status: early development](https://img.shields.io/badge/status-early%20development-orange.svg)](#路线图)
[![Runs on Cloudflare](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)

> English: [`README.md`](./README.md) · 完整构建规格：[`PROJECT_PLAN.zh-CN.md`](./PROJECT_PLAN.zh-CN.md)

pvuv.ai 是一个自己部署在 Cloudflare 边缘上的轻量统计平台。它不止统计 PV/UV，还为每一次访问打真实性分数，识别只在群体维度才暴露的虚假流量，并可以让广告代码只在判定为可信的流量上加载——帮助保护广告账号免受虚假流量牵连。

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

## 快速开始

**完整分步教程：[`DEPLOY.zh-CN.md`](./DEPLOY.zh-CN.md)**（English: [`DEPLOY.md`](./DEPLOY.md)）。简版：

**前置**：Node.js 18+、开通 **Workers Paid 套餐**的 Cloudflare 账号（Queues 需要付费套餐）、一个接入 Cloudflare 的域名。

```bash
# 1. 克隆
git clone https://github.com/qiayue/pvuv.ai.git
cd pvuv.ai
npm install                                    # 会同时生成打分配置

# 2. 创建 Cloudflare 资源
npx wrangler d1 create pvuv-db
npx wrangler kv namespace create BLOCKLIST
npx wrangler kv namespace create SITE_CONFIG
npx wrangler queues create pvuv-ingest
npx wrangler queues create pvuv-ingest-dlq

# 3. 配置 —— 替换 wrangler.toml 和 workers/*/wrangler.toml 里的
#    PLACEHOLDER_* 占位 id，把路由 pattern 改成你的域名，
#    （可选）私有调参：
cp config.example.toml config.local.toml       # 已 gitignore
npm run config:gen

# 4. 建表、部署、设密钥（三处 HMAC_KEY 必须是同一个值）
npm run db:migrate:remote
npm run deploy:all
npx wrangler secret put HMAC_KEY       -c workers/ingest/wrangler.toml
npx wrangler secret put HMAC_KEY       -c workers/api/wrangler.toml
npx wrangler secret put HMAC_KEY       -c workers/console/wrangler.toml
npx wrangler secret put API_TOKEN      -c workers/api/wrangler.toml
npx wrangler secret put ADMIN_PASSWORD -c workers/console/wrangler.toml

# 5. 构建并托管 SDK
npm run build:sdk
cp sdk/dist/f.js workers/console/public/f.js && npm run deploy:console
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

## 配置

评分权重、判定阈值、黑名单都是**可调且部署私有**的。`config.example.toml` 提供示例默认值；复制为 `config.local.toml`（已 gitignore）自行私有调优。引擎从 config 读取权重、代码不硬编码，因此可以在不暴露给刷手的前提下调整检测。详见 [`PROJECT_PLAN.zh-CN.md` §21](./PROJECT_PLAN.zh-CN.md)。

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

[GNU AGPL-3.0](./LICENSE)。你可以自由自托管和修改，但若以网络服务形式运行修改版，须向用户提供其源码。这既保持项目开放，又防止闭源商业分叉。
