/**
 * AI analysis report (PROJECT_PLAN.md §13).
 *
 * Gathers a compact, factual snapshot of one site over a period (traffic
 * summary, quality/invalid-traffic breakdown, top sources & pages, the
 * rule-based alerts and the baseline anomalies), turns it into a grounded
 * prompt, and asks the deployer's configured LLM to write a short markdown
 * report. The numbers come entirely from our own D1 — the model only narrates
 * and advises, it is never the source of a metric.
 */

import { overview, quality, breakdown, alerts, anomalies, type Period } from '../../api/src/queries';
import { callLLM, type AiConfig } from './llm';

export type ReportLang = 'en' | 'zh';

/** Format a millisecond duration as e.g. "8m 22s" / "45s". */
function dur(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%';
  return ((part / whole) * 100).toFixed(1) + '%';
}

/** Build a plain-text, number-dense snapshot the model can reason over. */
function snapshotText(
  siteName: string, period: Period,
  ov: Awaited<ReturnType<typeof overview>>,
  ql: Awaited<ReturnType<typeof quality>>,
  src: Awaited<ReturnType<typeof breakdown>>,
  pages: Awaited<ReturnType<typeof breakdown>>,
  al: Awaited<ReturnType<typeof alerts>>,
  an: Awaited<ReturnType<typeof anomalies>>,
): string {
  const totalVerdict = ov.clean_count + ov.suspect_count + ov.bot_count + ov.crawler_count;
  const invalid = ov.suspect_count + ov.bot_count + ov.crawler_count;
  const lines: string[] = [];
  lines.push(`Site: ${siteName}`);
  lines.push(`Period: ${period.start} … ${period.end} (timezone ${period.tz})`);
  lines.push('');
  lines.push('== Traffic summary ==');
  lines.push(`Pageviews: ${ov.pv}`);
  lines.push(`Unique visitors: ${ov.uv}`);
  lines.push(`Sessions: ${ov.sessions}`);
  lines.push(`Bounce rate (engaged, GA4): ${ov.bounce_rate != null ? (ov.bounce_rate * 100).toFixed(1) + '%' : 'n/a'}`);
  lines.push(`Bounce rate (single-page): ${ov.bounce_rate_single != null ? (ov.bounce_rate_single * 100).toFixed(1) + '%' : 'n/a'}`);
  lines.push(`Avg engaged time: ${dur(ov.avg_duration_ms)}`);
  lines.push(`Avg visit duration (first→last pageview): ${dur(ov.visit_duration_ms)}`);
  if (ov.conversions) lines.push(`Conversions (goal events): ${ov.conversions}`);
  if (ov.revenue) lines.push(`Revenue (USD): ${ov.revenue.toFixed(2)}`);
  lines.push('');
  lines.push('== Traffic quality (verdicts over pageviews) ==');
  lines.push(`Clean (human): ${ov.clean_count} (${pct(ov.clean_count, totalVerdict)})`);
  lines.push(`Suspect: ${ov.suspect_count} (${pct(ov.suspect_count, totalVerdict)})`);
  lines.push(`Bot: ${ov.bot_count} (${pct(ov.bot_count, totalVerdict)})`);
  lines.push(`Crawler: ${ov.crawler_count} (${pct(ov.crawler_count, totalVerdict)})`);
  lines.push(`Invalid share (suspect+bot+crawler): ${pct(invalid, totalVerdict)}`);
  // top firing bot signals
  const firing = Object.entries(ql.flags).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (firing.length) {
    lines.push('Top bot signals fired (signal: pageviews):');
    for (const [name, n] of firing) lines.push(`  - ${name}: ${n}`);
  }
  lines.push('');
  lines.push('== Top sources (sessions) ==');
  for (const r of (src.rows as Array<Record<string, unknown>>).slice(0, 8)) {
    lines.push(`  - ${r.key ?? r.source ?? '(direct)'}: ${r.sessions ?? r.visitors ?? r.uv ?? r.n ?? 0}`);
  }
  lines.push('');
  lines.push('== Top pages (pageviews) ==');
  for (const r of (pages.rows as Array<Record<string, unknown>>).slice(0, 8)) {
    lines.push(`  - ${r.key ?? r.path ?? '?'}: ${r.pv ?? r.pageviews ?? 0}`);
  }
  lines.push('');
  lines.push('== Automated alerts (rule-based, this period) ==');
  if (al.alerts.length === 0) lines.push('  (none — no threshold breached)');
  for (const a of al.alerts) lines.push(`  - [${a.severity}] ${a.title}: ${a.detail}`);
  lines.push(`  Forged-search pageviews: ${al.stats.fake_search} of ${al.stats.search_pv} search-referred (${pct(al.stats.fake_search, al.stats.search_pv)}); datacenter pageviews: ${al.stats.datacenter}; zero-interaction: ${al.stats.zero_interaction}.`);
  lines.push('');
  lines.push('== Recent baseline anomalies (vs trailing average) ==');
  if (an.anomalies.length === 0) lines.push('  (none pending)');
  for (const a of an.anomalies.slice(0, 8)) {
    lines.push(`  - ${a.day} ${a.dimension} (${a.kind}): baseline ${a.baseline}, actual ${a.actual} — ${a.message}`);
  }
  return lines.join('\n');
}

const SYSTEM: Record<ReportLang, string> = {
  en:
    'You are a senior web-analytics and ad-fraud analyst for a self-hosted analytics platform. ' +
    'Given a factual data snapshot, write a concise, decision-oriented report in Markdown. ' +
    'Use ONLY the numbers provided — never invent metrics or trends that are not in the data. ' +
    'Structure it with these sections: "## Overview", "## Traffic quality", "## Notable signals", "## Recommendations". ' +
    'Be specific and quantitative, call out anything that looks like invalid or forged traffic, and keep it under ~450 words.',
  zh:
    '你是一个自托管网站分析平台的资深流量分析与广告反作弊专家。' +
    '根据下面提供的真实数据快照，用 Markdown 写一份简洁、可执行的分析报告。' +
    '只能使用所给的数字，绝不能编造数据中没有的指标或趋势。' +
    '请包含这些小节：“## 概览”“## 流量质量”“## 值得注意的信号”“## 建议”。' +
    '要具体、量化，重点指出任何疑似无效流量或伪造来源的迹象，全文控制在 450 字以内。',
};

const USER_INTRO: Record<ReportLang, string> = {
  en: 'Here is the data snapshot. Write the report.\n\n',
  zh: '这是数据快照，请据此撰写报告。\n\n',
};

/**
 * Generate a report for one site/period using the configured LLM. Returns the
 * markdown plus the raw snapshot text (stored alongside for auditability).
 */
export async function generateReport(
  db: D1Database, siteId: string, siteName: string, period: Period,
  cfg: AiConfig, lang: ReportLang,
): Promise<{ content: string; snapshot: string }> {
  const [ov, ql, src, pages, al, an] = await Promise.all([
    overview(db, siteId, period),
    quality(db, siteId, period),
    breakdown(db, siteId, 'source', period, 8),
    breakdown(db, siteId, 'page', period, 8),
    alerts(db, siteId, period),
    anomalies(db, siteId, 10),
  ]);
  const snapshot = snapshotText(siteName, period, ov, ql, src, pages, al, an);
  const content = await callLLM(cfg, SYSTEM[lang], USER_INTRO[lang] + snapshot);
  return { content, snapshot };
}
