# pvuv.ai — 自托管网站统计 · 反虚假流量 · 广告防护平台

> **项目规划文档**（交付 Claude Code 用）· v1.1
> Repo: https://github.com/qiayue/pvuv.ai · License: AGPL-3.0（见 §22）
> English version / 英文版（主文档）：[`PROJECT_PLAN.md`](./PROJECT_PLAN.md)

**pvuv.ai** 是一个自托管、隐私友好的网站流量统计平台，跑在 Cloudflare Workers + D1 上。它把全维度流量统计（多站点、多子域、per-page PV/UV、来源、UTM 与全部跟踪参数、跳出率、停留时长、含金额的自定义事件、会话级与用户级归因）、三层虚假流量识别、以及一个可选的广告防护层（判定可信才加载广告代码）叠加在一起。本文件是构建规格说明。

> **开源须知（先读 §21–§22）**：本文档进入公开仓库。凡涉及具体评分权重、阈值、黑名单等「可被规避的调优参数」，一律作为**示例默认值**，实际生产值应放进 gitignore 的私有 config，不提交仓库。仓库内**严禁任何密钥**。

---

## 0. 一句话定位

一个自托管、隐私友好的网站流量统计平台，三个能力叠加：

1. **全维度流量统计**：多站点、多子域、多内页的 PV/UV、来源、UTM 与全部跟踪参数、跳出率、停留时长、自定义事件（含付费金额）、会话级与用户级全链路归因。
2. **虚假流量识别**：前端信号（单点）+ 会话特征（缝合）+ 群体统计（批量）三层判定，每条流量打 0–100 分并记录命中信号；具备跨站识别能力。
3. **广告防护（可选）**：判定为可信才加载广告代码，渐进式判定（第二页起可精准拦截），降低虚假流量对广告账号的拖累。

数据供三方消费：站长后台、外部排名/评分系统（可选）、AI 分析报告。

---

## 1. 域名与地址规划

分「对外暴露」（嵌在被统计站点上、将来可能进拦截列表）与「对内使用」（后台/API，不暴露）两类。以下为参考部署地址，可按自己域名调整。

| 类别 | 组件 | 地址 | 说明 |
|---|---|---|---|
| 对外暴露 | SDK 脚本 | `https://js.pvuv.ai/f.js`（版本化 `/f.v1.js`） | 纯静态，长缓存，走 CDN |
| 对外暴露 | 上报接口 | `POST https://in.pvuv.ai/in` | 热路径，极简快返 |
| 对外暴露 | 快速判定 | `POST https://in.pvuv.ai/v` | 广告放行判定 |
| 对内使用 | 查询 API | `https://api.pvuv.ai/v1/...` | 后台/排名/AI 共用 |
| 对内使用 | 控制台后台 | `https://pvuv.ai/`（主域名） | 站长登录、看板 |

**设计要点**

- 暴露子域（`js`、`in`）与内部（`api`、主域后台）分离：暴露子域若进拦截列表，后台与 API 不受影响。
- API 用 `api.pvuv.ai` 子域即可，不必单独注册域名（不嵌在被统计站点上，不会被拦；地址为路由绑定，未来迁独立域名零代码改动）。
- 命名避开拦截关键词（stat/track/analytics/collect/event/pixel/count）。脚本 `f.js`、上报 `/in`、判定 `/v` 均中性。
- 提供 `data-api` 属性，支持指向自建反代地址（见 §12）。

**嵌入代码**

```html
<script defer src="https://js.pvuv.ai/f.js"
        data-site="Ab3xK9pQ"
        data-adguard="balanced"
        data-adclient="ca-pub-xxxxxxxxxxxxxxxx"></script>
```

可选属性：`data-spa="true"`（监听 pushState 路由）、`data-api`（自定义上报地址）、`data-exclude="/admin/*"`（路径排除）、`data-sensors="off"`（关闭移动端传感器信号，供合规，见 §4.6）。

---

## 2. 技术栈（Cloudflare 全家桶）

- **Workers**：ingest（`/in` `/v`）、api（`/v1/*`）、console（后台）、consumer（Queue 消费者，打分与落库）、cron（定时聚合与批量分析）。
- **D1**：主库（SQLite）。事件原始表按月分表，绕开单库容量限制。
- **Queue**：`/in` 接收后先入队，消费者批量写 D1，抗峰值。
- **KV**：黑名单、站点配置缓存（供 `/v` 边缘读取）。HMAC 密钥用 Workers Secrets。
- **Cron Triggers**：每小时 rollup + 画像更新；每天群体分析 + 黑名单刷新 + AI 报告。
- **R2**（M2+，可选）：老月份原始事件归档、静态资源托管。
- **静态托管**：`js.pvuv.ai` 用 Workers Static Assets 或 R2 + CDN，f.js 长缓存。

**数据流**

```
浏览器(f.js)
  → in.pvuv.ai/in  (Worker: 校验+服务端补全+实时初审打分)
  → Queue
  → consumer Worker (批量写 D1 events / 增量更新 sessions)
  → Cron 每小时 → rollup 预聚合表
  → Cron 每天 → 群体分析 → 改判 verdict + 写 KV 黑名单（闭环回 /v）
```

---

## 3. 标识体系（系统地基）

四层 ID：`site_id → visitor_id → session_id → user_id`。

- **site_id**：注册站点时分配，8 位随机串。一个 site 绑定多个域名/子域名（`allowed_domains` 白名单，防盗用）。
- **visitor_id**：UUID，首访生成。写一方 Cookie `_pv_id`（`domain=.example.com` 跨子域共享），localStorage 备份。有效期 13 个月。
- **session_id**：UUID。开新会话条件（任一）：30 分钟无活动 / UTM 变化 / 跨自然日。存 Cookie `_pv_sid` + 最后活动时间戳。
- **user_id**：`identify()` 后绑定。`identities` 表维护 user↔visitor 映射，实现同一用户多设备多会话合并。
- **首触归因快照**：首访存 referrer + UTM 于 Cookie `_pv_ft`（永不覆盖）。转化事件同时带首触与末触。
- **判定状态 Cookie** `_pv_v`：HMAC 签名，存当前 verdict、已看页数、是否交互、上页停留时长，客户端改不了，供 `/v` 复审。

---

## 4. 数据采集 SDK（f.js）

### 4.1 自动采集（零配置）

- **pageview**：加载时 + SPA 路由切换（`data-spa`）。
- **page_leave**：`visibilitychange` + `pagehide`，`sendBeacon` 发送，带 `duration_ms`（真实可见停留）与 `scroll_depth`。跳出率、停留时长靠此事件算。
- **outbound_click**：外链点击。

### 4.2 JS API

```js
pvuv.track('signup', { plan: 'free' });
pvuv.track('purchase', { revenue: 49.9, currency: 'USD', order_id: 'x', product: 'pro_yearly' });
pvuv.identify('user_123', { plan: 'pro' });
pvuv.reset();
```

`revenue` + `currency` 为保留字段，服务端按日汇率折算 `revenue_usd` 存一份，便于跨站/排名比较。

### 4.3 采集字段

URL（服务端解析 path/hostname/UTM/click_id）、referrer、三级 ID、屏幕宽高、语言、自定义属性、`duration_ms`/`scroll_depth`、是否交互及首次交互时间。

### 4.4 真实性信号采集（字段名混淆为 x1/x2…）

> 权重见 §6.2，均为**示例默认值**，实际值外置于私有 config（§21）。

**便宜检测（每次跑，微秒级）**：`navigator.webdriver`；自动化残留全局变量（`_phantom`/`__nightmare`/`$cdc_*`/`callPhantom`）；Chrome UA 但 `window.chrome` 缺失；`navigator.languages` 空；桌面 UA 但 `plugins.length===0`；屏幕矛盾（screen 与 innerWidth/Height 完全相等 / 800×600 / colorDepth===0）；设备矛盾（手机 UA 但 maxTouchPoints===0；hardwareConcurrency/deviceMemory 异常）；时区矛盾（Intl timeZone vs 服务端 cf.timezone）；语言矛盾。

**昂贵检测（`requestIdleCallback` 抽样，缓存结果）**：WebGL renderer（SwiftShader/llvmpipe/Mesa OffScreen = 软件渲染）；Canvas 渲染哈希（检测同环境批量伪装多访客）；权限矛盾（Notification.permission=denied 但 permissions.query 返回 prompt）。

**行为信号（只记是否发生+首次时间，不记轨迹）**：首个 mousemove/touchstart/scroll/keydown；page_leave 是否发送；蜜罐链接（CSS 隐藏，真人不点、部分爬虫会点）。

### 4.5 adguard 广告防护模块

判定通过后**动态注入** `adsbygoogle.js`（只决定是否注入，**不修改** Google 脚本行为——政策红线）。逻辑见 §7。

### 4.6 移动端传感器信号（信号非指纹，隐私安全）

**平台现状（2026）**：iOS（Safari 及全部 iOS 浏览器）自 iOS 13 起访问 DeviceMotion/DeviceOrientation 必须 `requestPermission()` 且需用户手势触发、会弹框；Generic Sensor API（Accelerometer/Gyroscope）iOS 完全不支持。Android Chrome 对同源顶层文档、安全上下文、页面可见时**免弹窗**可读。

**因此本项目的原则**：

- **绝不为统计弹授权框**，绝不采集原始传感器流做指纹（传感器数据是已知的隐蔽指纹/侧信道来源，静默采集踩隐私合规红线，也加速被拦截列表收录）。
- **仅在 Android、被动、粗粒度**地用作 bot 信号：短暂监听 `devicemotion`（不弹窗），只提取布尔标记——
  - `has_motion`：手机 UA 但窗口期零 motion 事件 → 可疑
  - `motion_static`：`accelerationIncludingGravity` 跨采样完全恒定、无微抖动 → 模拟器/无头特征
- 只存这两个标记，不存原始读数、不做传感器指纹。
- iOS 直接跳过传感器信号，靠其他信号。
- 实现：`try/catch` + permissions-policy 检测，失败静默；受 `data-sensors="off"` 控制，默认可开，合规敏感区域可关。
- 新增 bot_flags 位：`0x1000 手机UA但无motion数据(Android)`、`0x2000 motion读数完全静止`。

---

## 5. 上报接口 /in

```
POST https://in.pvuv.ai/in
Content-Type: text/plain        ← 避免 CORS 预检，省一半请求
Body: JSON（单条或数组；SDK 攒批，≤10 条或每 3 秒发一次）
```

**单条事件结构**

```json
{
  "s": "Ab3xK9pQ", "e": "pageview",
  "u": "https://a.com/pricing?utm_source=x", "r": "https://google.com/",
  "vid": "...", "sid": "...", "uid": "...",
  "sw": 1920, "sh": 1080, "lang": "zh-CN",
  "p": { "...": "..." }, "d": 45200,
  "x": { "x1": 0, "x2": 1, "...": "..." },
  "ts": 1752000000000
}
```

**服务端补全（客户端不传，防伪造）**：地理（`request.cf`）；ASN（`cf.asn` 查数据中心库判 asn_type）；UA 解析（browser/os/device_type）；IP 只存 SHA256 截断哈希 + /24 段哈希；URL 解析出 UTM 与 click_id（gclid/fbclid/ttclid/msclkid/ref）单独建列，其余存 `extra_params`。

**校验**：`Origin`/`Referer` 比对 site 的 `allowed_domains`，不符丢弃。

**实时初审打分**：写全 4 个反作弊字段（§6.2），`score_stage='realtime'`。接口极简快返，复杂分析放消费端。

---

## 6. 反虚假流量判定（三层）

> **开源提示**：本节描述架构与信号目录（客户端反欺诈本就无法对读代码者隐藏，公开有利于透明与审计）。但**具体权重、分档阈值、黑名单**属可规避调优参数，应外置于私有 config，仓库内只提交示例默认值（§21）。

### 6.1 三层信号

1. **服务端信号（最可靠）**：数据中心 ASN、已知爬虫/脚本 UA、请求头完整性（Sec-Fetch/Sec-CH-UA 缺失或矛盾）、协议层（HTTP/TLS 版本）、时序规律性。
2. **客户端环境信号**：见 §4.4 与 §4.6。
3. **行为信号（最难伪造，权重最高）**：交互有无、page_leave 缺失、停留分布、蜜罐触发。

### 6.2 评分与落库字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `bot_score` | INTEGER | 0–100 |
| `verdict` | TEXT | clean / suspect / bot / crawler |
| `bot_flags` | INTEGER | 命中信号位图（一个 INT 存 32 位） |
| `score_stage` | TEXT | realtime / session / batch |

**bot_flags 位定义与示例权重**（权重仅为初始默认，externalize 到 config）

| 值 | 信号 | 示例权重 |
|---|---|---|
| 0x0001 | webdriver=true | 硬信号→100 |
| 0x0002 | 自动化框架残留 | 硬信号→100 |
| 0x0004 | UA/ClientHints 矛盾 | +25 |
| 0x0008 | 数据中心 ASN | +35 |
| 0x0010 | Sec-Fetch 头缺失 | +25 |
| 0x0020 | 时区/IP 矛盾 | +20 |
| 0x0040 | 零交互无 page_leave | +20 |
| 0x0080 | 软件渲染 WebGL | +15 |
| 0x0100 | 时序机械规律 | +15 |
| 0x0200 | 命中黑名单簇 | +40 |
| 0x0400 | 蜜罐触发 | 硬信号→100 |
| 0x0800 | 屏幕/设备矛盾 | +10/项 |
| 0x1000 | 手机UA但无motion数据(Android) | +15 |
| 0x2000 | motion读数完全静止 | +10 |
| — | 住宅/移动 ASN + 有交互 + 有 leave | 信任减分 −10/项 |

**示例分档**：0–29 clean｜30–69 suspect｜70+ bot。verified crawler 单独归类。`score_stage` 记录本条分是哪一审给的，支持展示「初审→批量改判」的变化。

### 6.3 会话层（每小时 Cron）

把事件缝合成会话，算会话级特征（页间间隔、路径模式、零交互/无 leave），修正 verdict（`score_stage='session'`）。

### 6.4 群体层批量分析（每天 Cron）— 找「同一只手」

**时序规律性**：每 visitor 事件间隔的变异系数 CV（真人 >1，脚本趋近 0）；按目标时区 24 小时昼夜曲线（与历史基线余弦相似度）；小时级 pv 序列自相关找固定周期。

**分布形态检验**（真实长尾、伪造扁平或过度集中）：对 UA / 分辨率 / 停留时长 / 会话深度 / 着陆页 / 回访比例算熵与集中度，与基线对比。两头都警惕——过整齐与过随机都异常。

**聚簇分析**：指纹簇 `GROUP BY fp_hash HAVING COUNT(DISTINCT visitor_id) > 阈值`；IP 段簇（/24 贡献占比 + ASN 爆量）；行为序列簇（路径 + 各页停留离散化成签名串）；cookie 重置（同 IP 段 + 同指纹但 visitor_id 不断更换、各只出现一次）。

**基线与异动**：每站每维度滚动基线（EWMA + MAD，抗离群）。pv/uv 突增且来源/地理/设备结构同时突变 → 可疑；某 utm_campaign 凭空大量流量但零转化 → 可疑。新站无基线用同类站群基线兜底。

**跨站分析**：同一指纹/IP 段短时间扫过多个站点 → 全局拉黑。跨站黑名单三保险：优先指纹簇+行为证据（慎用纯 IP，防 CGNAT/校园网误杀）；条目带 TTL 与衰减（默认 7–30 天，永久仅留硬信号实锤）；只共享判定结果不共享行为数据。

**产出**：确认簇写 KV 黑名单（闭环回 `/v`）；对确认簇历史事件批量改判 `verdict`（`score_stage='batch'`），增量重算 rollup。

### 6.5 实现要点

本质是 `GROUP BY + 聚合 + HAVING`（D1 舒适区）；熵/CV 等算子在 Worker 用 JS 算完存列；visitor 间隔统计用 **Welford 在线算法** 增量更新；路径签名聚类按站点分片。

### 6.6 处置策略

bot 自动剔除（不计 clean 口径）；suspect 计入但降权并标注，结算前人工过一遍；自动改判阈值设保守，灰色地带留人工——误杀真实流量比放过刷子更伤公信力。

---

## 7. 广告防护（adguard 渐进式判定）

### 7.1 核心思想

第一页快速放行/拦截是「初审」，会话内每多一个事件多一份证据，第二页起「复审」。刷子最多骗到一次首页展示，骗不到持续展示。

### 7.2 决策链路

```
页面加载 → f.js 本地硬检测（<1ms）
  ├ 命中硬信号 → 永不加载广告
  ├ 有签名 Cookie(_pv_v，上次 clean) → 立即加载
  └ 新访客 → 并行：
       ① POST in.pvuv.ai/v 快速判定（边缘，目标 <80ms）
       ② 监听首个真人交互
     按模式决定：
       宽松：只跑①，300ms 超时未响应 → 直接加载（fail-open 保收入）
       平衡(默认)：①通过 或 ②发生 → 加载
       严格：①通过 且 ②发生 → 加载
```

判定结果 HMAC 签名写 `_pv_v`，回头客零延迟。

### 7.3 渐进拦截时机

| 阶段 | 拦截点 |
|---|---|
| 首次会话 | 第 2 页起（行为证据） |
| 再次来访 | 第 1 页（Cookie 记 verdict） |
| 清 Cookie 再来 | 第 1 页（指纹簇/IP 段进 KV 黑名单） |
| 换站再刷 | 第 1 页（跨站黑名单全网生效） |

执行点在「下一页」，不回收已加载广告（避免布局跳动、无收益）。

### 7.4 关键细节

- 「交互后加载」本身过滤大部分 bot，且广告不参与首屏渲染，改善 LCP/INP（白送的 Core Web Vitals）。
- **verified crawler 放行页面、不加载广告**：Googlebot、Mediapartners-Google 正常抓取内容，本就不需广告脚本。
- suspect 灰色地带：加载但延迟 + 要求更强交互证据（如滚动过一屏才注入）。
- **fail-open 兜底**：判定超时 / f.js 报错 / KV 挂 → 一律默认加载广告。宁漏拦不误伤收入。
- **边界**：仅用于过滤无效流量，不做「按点击倾向选择性加载」等操纵逻辑；不修改 Google 脚本。本工具是防护层不是免罪牌，核心附加价值在「拦截 + 坏流量溯源报告」。

### 7.5 阈值交给站长（平台只给能力 + 影响预估）

三档预设（宽松/平衡/严格）+ 自定义（score 滑块 + 信号开关）。**影子模式**：新接入前 7 天只记录不拦截，展示「按当前档位会拦截 X%、来源分布如下」；任何调整先回测预估再生效。面板每档实时显示预计拦截率与预计误杀率（用「被拦流量中有真人交互特征占比」估算）。

---

## 8. 快速判定接口 /v

```
POST https://in.pvuv.ai/v
Body: { s, vid, sid, x{...}, state(来自签名Cookie) }
```

全部查边缘本地数据：`cf.asn` 判数据中心、请求头完整性、KV 黑名单。目标 <80ms。入参带签名 Cookie 会话状态摘要，第二页判定叠加行为证据。返回 verdict + 是否放行广告，写回 `_pv_v`。

---

## 9. 存储架构与数据库 Schema

### 9.1 分层

- **原始层**：`events_YYYYMM` 按月分表；`sessions`；`identities`；`visitor_profiles`。
- **聚合层**：`rollup_page_daily`、`rollup_source_daily`、`rollup_site_daily`。面板 95% 查聚合表。

### 9.2 D1 Schema（M1 建表 DDL）

```sql
-- 用户
CREATE TABLE users (
  user_id     TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT DEFAULT 'active'
);

-- 站点
CREATE TABLE sites (
  site_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  allowed_domains TEXT NOT NULL,             -- JSON 数组
  adguard_mode    TEXT DEFAULT 'off',        -- off/loose/balanced/strict/custom
  adguard_config  TEXT,                      -- JSON 自定义阈值/开关
  adclient        TEXT,                      -- ca-pub-xxx
  settings        TEXT,
  created_at      INTEGER NOT NULL,
  status          TEXT DEFAULT 'active'
);

-- 事件原始表（按月分表；示例 202607）
CREATE TABLE events_202607 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,
  event         TEXT NOT NULL,
  visitor_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  user_id       TEXT,
  url           TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  path          TEXT NOT NULL,
  referrer      TEXT,
  ref_domain    TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  click_id TEXT, click_id_type TEXT,
  extra_params TEXT,
  country TEXT, region TEXT, city TEXT,
  browser TEXT, os TEXT, device_type TEXT,
  screen_w INTEGER, screen_h INTEGER,
  lang TEXT,
  ip_hash TEXT, ip24_hash TEXT,
  asn INTEGER, asn_type TEXT,
  fp_hash TEXT,
  duration_ms INTEGER, scroll_depth INTEGER, had_interaction INTEGER DEFAULT 0,
  revenue REAL, revenue_usd REAL, currency TEXT,
  props TEXT,
  ft_source TEXT, ft_medium TEXT, ft_campaign TEXT, ft_referrer TEXT,
  bot_score INTEGER DEFAULT 0,
  verdict TEXT DEFAULT 'clean',
  bot_flags INTEGER DEFAULT 0,
  score_stage TEXT DEFAULT 'realtime',
  ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ev0_site_ts ON events_202607(site_id, ts);
CREATE INDEX idx_ev0_visitor ON events_202607(site_id, visitor_id);
CREATE INDEX idx_ev0_session ON events_202607(session_id);
CREATE INDEX idx_ev0_verdict ON events_202607(site_id, verdict, ts);
CREATE INDEX idx_ev0_path    ON events_202607(site_id, path);

-- 会话
CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  visitor_id   TEXT NOT NULL,
  user_id      TEXT,
  entry_page   TEXT, exit_page TEXT,
  pageviews INTEGER DEFAULT 0, events_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0, had_interaction INTEGER DEFAULT 0,
  is_bounce INTEGER,
  source TEXT, medium TEXT, campaign TEXT, referrer TEXT,
  country TEXT, device_type TEXT,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean', bot_flags INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
);
CREATE INDEX idx_sess_site ON sessions(site_id, started_at);
CREATE INDEX idx_sess_visitor ON sessions(site_id, visitor_id);

-- 身份映射
CREATE TABLE identities (
  site_id TEXT NOT NULL, user_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  traits TEXT, first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, user_id, visitor_id)
);

-- 访客画像（批量分析增量更新）
CREATE TABLE visitor_profiles (
  site_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  events_count INTEGER DEFAULT 0, sessions_count INTEGER DEFAULT 0,
  interval_mean REAL, interval_m2 REAL, interval_cv REAL,
  active_hours INTEGER,
  fp_hash TEXT, ip24_hash TEXT, asn INTEGER,
  bot_score INTEGER DEFAULT 0, verdict TEXT DEFAULT 'clean',
  first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (site_id, visitor_id)
);
CREATE INDEX idx_vp_fp   ON visitor_profiles(fp_hash);
CREATE INDEX idx_vp_ip24 ON visitor_profiles(ip24_hash);

-- 每日聚合（含 clean 口径）
CREATE TABLE rollup_page_daily (
  site_id TEXT, day TEXT, hostname TEXT, path TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounces INTEGER DEFAULT 0, total_duration_ms INTEGER DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, hostname, path)
);
CREATE TABLE rollup_source_daily (
  site_id TEXT, day TEXT, source TEXT, medium TEXT, campaign TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  pv_clean INTEGER DEFAULT 0, uv_clean INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, day, source, medium, campaign)
);
CREATE TABLE rollup_site_daily (
  site_id TEXT, day TEXT,
  pv INTEGER DEFAULT 0, uv INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0,
  bounce_rate REAL, avg_duration_ms INTEGER,
  bot_count INTEGER DEFAULT 0, suspect_count INTEGER DEFAULT 0,
  crawler_count INTEGER DEFAULT 0, clean_count INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0, revenue_usd REAL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);

-- 簇 / 异动 / AI（M2+，M1 建表预留）
CREATE TABLE cluster_flags (
  cluster_id TEXT PRIMARY KEY, site_id TEXT,
  type TEXT, member_count INTEGER, evidence TEXT,
  action TEXT DEFAULT 'observe', created_at INTEGER, expires_at INTEGER
);
CREATE TABLE anomaly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, day TEXT, dimension TEXT,
  baseline REAL, actual REAL, deviation REAL,
  related_cluster TEXT, evidence TEXT,
  status TEXT DEFAULT 'pending', created_at INTEGER
);
CREATE TABLE ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT, period TEXT, kind TEXT,
  content TEXT, data_snapshot TEXT, created_at INTEGER
);
```

### 9.3 关键口径

- **跳出率（反向定义，参考 GA4）**：会话有第二个 pageview、或停留 ≥10 秒、或有任何自定义事件 = 互动会话；跳出率 = 1 − 互动率。
- **clean 口径**：rollup 同时统计全量与 clean（排除 bot/crawler）。面板默认展示 clean，可切换。verified crawler 单独计。
- **保留策略**：原始事件保留 30–90 天供下钻，更久只留聚合与簇记录。归因/指纹只存哈希，不存原始指纹值。

---

## 10. 查询 API

Base：`https://api.pvuv.ai/v1`

```
GET /sites/:id/overview?period=30d
GET /sites/:id/timeseries?metric=pv&interval=day
GET /sites/:id/breakdown?dim=page|source|utm_campaign|country|device&period=...&filter=...
GET /sites/:id/funnel?steps=pageview:/pricing,signup,purchase
GET /sites/:id/visitors/:vid/sessions
GET /sites/:id/sessions/:sid/events
GET /sites/:id/visitors/:vid/profile
GET /sites/:id/attribution?event=purchase&model=first|last|last_non_direct
GET /sites/:id/quality?period=30d
GET /sites/:id/traffic?verdict=bot&min_score=70&period=...
```

breakdown 支持多维度组合过滤。外部排名系统与 AI 分析复用同一套 API。鉴权：站长只查自己的 site；外部系统/AI 用服务端 token。

---

## 11. 后台控制台（pvuv.ai）

### 11.1 流量看板

概览指标卡、时间趋势、来源/页面/UTM/地理/设备 breakdown、漏斗、访客→会话→事件下钻时间线。

### 11.2 流量质量板块

**概览层**：clean/suspect/bot/crawler 环形图；bot 占比按天趋势；一句话预警。
**列表层**：可筛可排明细（分数区间滑块、verdict、具体 flag、来源、UTM、国家、时间段；默认按分数降序，红黄绿色阶）。
**下钻层**（高分流量行为还原）：① 判定依据卡片（每条命中信号 + 实测值 vs 正常值）；② 会话时间线（页间机械等距、路径异常红标）；③ 群体关联（`该指纹关联 N 个 visitor，跨 M 站出现`）。

### 11.3 口径克制

verified crawler 单独归类不混进 bot；suspect 用黄色（存疑非确凿）；避免新手满屏红色误以为被刷爆。

### 11.4 权限

数据站长可看/筛/导出，**改判权在平台**（走群体分析 + 人工复核），站长不能手动改判（否则广告防护数据失效）。

### 11.5 广告防护面板

拦截量趋势、拦截原因分布、**被拦流量来源渠道 Top 榜**（最有行动价值）、影子模式回测、模式切换。

---

## 12. 反代 / 第一方方案（进阶，抗拦截）

第三方统计域名做大后大概率进拦截列表。提供进阶方案：站长用自己域名的 Cloudflare Worker 反代 f.js 与上报接口，变真正第一方请求，基本免疫拦截。SDK 的 `data-api` 指向自建反代地址。仓库提供反代 Worker 配置模板与文档。默认直接嵌脚本，要数据准的人自配反代。

---

## 13. AI 自动分析

定时（每日/每周 Cron）+ 按需（面板按钮）。组装结构化 JSON（流量趋势、Top 来源变化、高跳出页、漏斗断点、异动/簇证据），调用 Claude API 产出报告存 `ai_reports`。输出固定格式：**数据异动 → 归因判断 → 3 条可执行建议**（每条注明预期影响 + 优先级）。异动/复核证据 JSON 喂给模型写「为什么判定可疑」的人话解释，附复核界面。API Key 走 Workers Secrets，绝不入库。

---

## 14. 外部排名 / 评分系统集成（可选）

平台不内置具体运营玩法，但查询 API（§10）足以支撑外部排名/评分/比赛系统对接：

- 站点接入 f.js 即进入数据流。
- 排名/评分用「过滤后（clean）数据」，异常明细保留可人工复核。
- 可按需区分「内部/受信来源流量」与「外部自然流量」，避免受信互访影响排名。
- 结算：bot 自动剔除，suspect 降权 + 人工过一遍。

此模块为可选适配层，核心平台不依赖它。

---

## 15. 反作弊工程要点（汇总）

1. 上报检测字段名混淆（x1/x2…），权重与判定逻辑在服务端；权重/阈值外置私有 config。
2. 昂贵检测 `requestIdleCallback` 延迟执行，不拖慢被统计站 Core Web Vitals。
3. 指纹只用于打分，不做跨站访客关联；原始指纹不落库，只存哈希与结论。
4. verified crawler 单独归类，Googlebot 需反向 DNS 验证防假冒。
5. 打分放 Queue 消费端（结合同 visitor 历史做时序分析），`/in` 极简。
6. 移动端传感器只做粗粒度信号、仅 Android、被动、可关闭（§4.6）。
7. 目标：不求防死，把伪造成本抬到不划算，真机真人刷靠人工复核兜底。

---

## 16. 隐私与合规

- IP 只存 SHA256 截断哈希 + /24 段哈希，不存明文。
- 设备指纹只存哈希与判定结论，不存原始值，不做跨站访客画像关联（仅反欺诈用途）。
- 判定依据卡片只展示结论与触发值，不展示完整指纹。
- 传感器仅粗粒度 anti-fraud 信号，不采原始流、不做传感器指纹；提供 `data-sensors="off"` 关闭开关。
- **合规提示（供部署者）**：在 GDPR/ePrivacy 辖区，设备指纹与传感器信号可能落入需用户同意的范畴。项目提供数据最小化默认与关闭开关，具体合规责任由各部署者按其法域评估（cookieless 模式、指纹/传感器关闭项应文档化）。
- 默认无广告、不向第三方出售数据；数据归各自部署者所有。

---

## 17. 分期路线

| 期 | 内容 |
|---|---|
| **M1**（首个可部署里程碑） | f.js（采集+硬检测+adguard 渐进加载+Android 传感器信号）、`/in`（含实时初审打分，写四字段）、`/v` 快速判定、D1 基础表、最简后台（PV/UV/来源/Top 页 + 流量质量概览） |
| **M2** | 会话/时长/跳出率、UTM 完整维度、rollup 加速、群体分析（指纹簇/IP 段簇 + blocklist 闭环）、影子模式、反代方案 |
| **M3** | identify + 自定义事件 + revenue + 漏斗归因、分布检验 + 基线异动 |
| **M4** | AI 报告 + 完整反作弊 + 外部排名对接 + 人工复核界面 |

---

## 18. M1 交付范围（Claude Code 首个里程碑）

**目标**：可部署内测的最小闭环。

必做：
1. **f.js**：pageview + page_leave（duration/scroll）自动采集；便宜档硬检测 + Android 传感器信号；adguard 平衡模式渐进加载（硬信号拦截 + 交互后加载）；Cookie 状态机（`_pv_id`/`_pv_sid`/`_pv_ft`/`_pv_v`，HMAC 签名）；攒批上报（text/plain）。
2. **ingest Worker（in.pvuv.ai）**：`/in` 校验白名单 + 服务端补全 + 实时初审打分（写全 4 字段）+ 入 Queue；`/v` 快速判定。
3. **consumer Worker**：Queue 批量写 events + 增量更新 sessions/identities/visitor_profiles。
4. **cron Worker**：每小时 rollup（page/source/site daily，含 clean 口径）。
5. **api Worker（api.pvuv.ai）**：overview / timeseries / breakdown / quality / traffic / visitor profile。
6. **console（pvuv.ai）**：登录、站点注册（发 site_id + 嵌入代码）、流量看板、流量质量概览 + 高分下钻。
7. **D1 schema**：§9.2 全部建表（M2+ 表也建好预留）。

M1 可略过（建表/留接口即可）：群体批量分析、分布检验、AI 报告、漏斗、影子模式回测。

---

## 19. 仓库结构（monorepo，保留目录层级）

```
pvuv.ai/
├── LICENSE                        # AGPL-3.0（见 §22）
├── README.md                      # 中英双语，项目介绍/架构/部署
├── CONTRIBUTING.md
├── SECURITY.md
├── .gitignore                     # 含 node_modules/.dev.vars/.env/dist 临时产物
├── PROJECT_PLAN.md                # 本文档
├── config.example.toml            # 示例权重/阈值（真实值放 config.local.*，gitignore）
├── wrangler.toml                  # 占位符 account_id / 绑定名，无密钥
├── package.json
├── sdk/
│   ├── src/f.ts
│   ├── build.mjs
│   └── dist/f.js                  # 部署到 js.pvuv.ai
├── workers/
│   ├── ingest/   (src/index.ts, enrich.ts, score.ts, wrangler.toml)   # in.pvuv.ai
│   ├── consumer/ (src/index.ts, wrangler.toml)
│   ├── api/      (src/index.ts, wrangler.toml)                          # api.pvuv.ai
│   ├── console/  (src/index.ts, public/, wrangler.toml)                 # pvuv.ai
│   └── cron/     (src/rollup.ts, src/batch.ts, wrangler.toml)
├── shared/
│   ├── schema.sql
│   ├── flags.ts                   # bot_flags 位定义（前后端共用）
│   ├── ids.ts                     # ID 生成 / Cookie / HMAC
│   └── asn.ts                     # 数据中心 ASN 判定
└── migrations/
```

**约定**：后台前端优先单 HTML/原生实现，避免框架调试成本；任何 HTML 页面 `<head>` 不加 `<meta name="keywords">`；KV 命名 `BLOCKLIST`/`SITE_CONFIG`，Queue `INGEST_QUEUE`，HMAC 密钥用 Workers Secrets；交付压缩包保留目录层级，勿扁平化。

---

## 20. 非目标 / 边界

- 不修改 Google 广告脚本行为，只决定是否注入（政策红线）。
- 不做「按点击倾向选择性加载」等操纵性逻辑。
- 不追求 100% 防刷，追求把伪造成本抬到不划算 + 人工复核兜底。
- 不替代 Google 服务端 IVT 判定；是防护层不是免罪牌。
- 不采原始传感器流、不做传感器/跨站访客指纹。

---

## 21. 开源须知：可规避参数外置化

公开仓库无法对读代码者隐藏客户端逻辑，因此本项目采用「代码开源、调优私有」策略：

- **提交仓库**：架构、信号目录、接口、schema、示例默认权重/阈值（`config.example.toml`）。
- **不提交仓库（gitignore）**：生产权重/阈值/黑名单/调优（`config.local.*`）、任何密钥、`.dev.vars`、`wrangler` 真实 account_id。
- 评分引擎从 config 读取权重，代码不硬编码生产值；各部署者可自行调优而不暴露给刷手。
- 反作弊架构公开有利于社区审计与信任，符合隐私工具定位；真正的「不对称优势」在私有调优 + 跨部署黑名单，而非隐藏算法。

---

## 22. 开源协议与安全

**License：AGPL-3.0（已确定）。** 理由：允许自托管与自由使用，但任何人（含以 SaaS 形式提供服务者）修改后必须开源其改动——防止他人直接拿本项目做闭源商业竞品，同时不影响自托管用户。Plausible / Umami / PostHog 等「自身也商业化的开源统计工具」均采此协议。

**开源前安全清单（务必逐项确认）**：
- [ ] 仓库无任何密钥（HMAC key、Cloudflare token、AI API key、`.dev.vars`）
- [ ] `.gitignore` 含 `node_modules`、`.dev.vars`、`.env`、`config.local.*`、`dist` 临时产物
- [ ] `wrangler.toml` 用占位符，真实 account_id / 绑定 ID 不入库
- [ ] 所有密钥走 `wrangler secret put`
- [ ] 历史提交中无误提交的密钥（用 `git log -p` / gitleaks 扫一遍；若曾提交，rotate 后再开源）
- [ ] `SECURITY.md` 提供漏洞上报渠道
- [ ] README 明确合规边界与部署者责任（§16）
