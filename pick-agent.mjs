#!/usr/bin/env node
/* pick-agent.mjs —— 选品 Agent：从罗盘市场数据里挑「值得做的新品」，不是复读自己店里卖过什么
 *
 *   node pick-agent.mjs              # 分析 + 写入候选（candidate → ceo_review）
 *   node pick-agent.mjs --dry        # 只看结论不写库
 *   node pick-agent.mjs --top 5      # 只取前 5 个机会（默认 5）
 *
 * 数据从哪来（都必须是真的）：
 *   罗盘 · 类目挖掘   机会层：增速、需求供给比、竞争小名次、最高成交价格带、自然流量占比
 *   罗盘 · 商品榜单   参照层：该类目 TOP 商品的真实价格带、成交件数、点击成交转化率、店铺
 *   本店 结算/订单/SKU  约束层：我们能不能做（同供应链）、卖多少钱能赚（只做提示，不替人定价）
 *
 * 打分公式（写死，可复算；raw 里同时留原始区间值，不拿中点冒充精确数）：
 *   机会分 = 0.45·增速分 + 0.35·需供比分 + 0.20·竞争分
 *     增速分   = min(1, 增速% / 30)
 *     需供比分 = min(1, log10(1+需供比) / 2)        需供比 100 → 1.00，10 → 0.52
 *     竞争分   = 竞争小名次 ? 1 - min(1, 名次/50) : 0.40（缺名次按中性，不假装）
 *   匹配加成 +0.10：类目名落在「面/粉/粮/干货/速食」一带（现有供应链能复用）
 *   排除条件（不产候选，只留理由）：增速 < 0；需供比 < 3（供给已经过剩）；价格带上限 < 10 元（没毛利空间）
 *
 * 边界（明说，不装）：
 *   ① 罗盘给的是区间值，mid 是推算的，不是平台精确数。
 *   ② 这里判断的是「市场需求侧值不值得做」，**不判断你能不能拿到货、能不能赚钱**——
 *      拿货价、起订量、账期必须你去问供应商，这是 P0，AI 不替你做。
 *   ③ 所以产出的候选只到「等你确认」，永远不会自己上架（服务端也拦着）。
 */

import fs from "node:fs";
import { db } from "./db.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const DRY = process.argv.includes("--dry");
const SHOP = process.env.PICK_SHOP || "shop_demo";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const TOP = Math.max(1, Number(arg("top", 5)));
const STALE_H = Number(process.env.PICK_STALE_HOURS || 12);

const C = { r: "\x1b[0m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[36m", red: "\x1b[31m" };
const y2 = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

// ── 1. 数据够不够新（不够就明说，不拿旧数当今天）──────────
const src = db.prepare(
  "SELECT source, COUNT(*) n, MAX(fetched_at) at FROM market_items WHERE source LIKE '罗盘%' GROUP BY source"
).all();
const mining = db.prepare("SELECT * FROM market_items WHERE source='罗盘·类目挖掘' ORDER BY fetched_at DESC").all();
const rankRows = db.prepare("SELECT * FROM market_items WHERE source='罗盘·商品榜单' ORDER BY fetched_at DESC").all();

const srcLine = src.map((s) => `${s.source} ${s.n} 条（${String(s.at).slice(5, 16).replace("T", " ")}）`).join(" · ");
console.log(`\n=== 选品 Agent ===\n数据：${srcLine || "无"}`);

if (!mining.length) {
  console.error(`\n${C.red}没有类目挖掘数据，选品不跑。${C.r}先抓：node sync.mjs compass-cate-mining compass-rank-goods`);
  process.exit(2);
}
const ageH = (Date.now() - Date.parse(String(src[0]?.at || 0))) / 3600000;
if (ageH > STALE_H) console.log(`${C.y}⚠ 市场数据已 ${ageH.toFixed(1)} 小时没更新（阈值 ${STALE_H}h），下面结论按这份旧数算的${C.r}`);

// ── 2. 参照层：商品榜单的分布（中位价 / 转化率 / 头部集中度）──
function stats(rows) {
  const prices = rows.map((r) => Number(r.price)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const cvrs = rows.map((r) => {
    try { return JSON.parse(r.raw || "{}")?.cvr_band?.mid ?? null; } catch { return null; }
  }).filter((x) => x != null).sort((a, b) => a - b);
  const shops = rows.map((r) => r.shop).filter(Boolean);
  const top3 = shops.slice(0, 3).length;
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
  return {
    样本: rows.length,
    价格中位: med(prices),
    价格区间: prices.length ? [prices[0], prices[prices.length - 1]] : null,
    转化率中位: med(cvrs),
    头部店铺: [...new Set(shops)].slice(0, 5),
    前3占比: shops.length ? +(top3 / shops.length).toFixed(2) : null,
  };
}
const ref = stats(rankRows);
console.log(`参照：商品榜 ${ref.样本} 条 · 价格 ${ref.价格区间 ? `${y2(ref.价格区间[0])}~${y2(ref.价格区间[1])}` : "—"}`
  + ` · 中位 ${ref.价格中位 ? y2(ref.价格中位) : "—"} · 转化中位 ${ref.转化率中位 ?? "—"}%`);

// ── 3. 机会层打分 ───────────────────────────────────────
const MATCH_RE = /面|粉|粮|干货|速食|杂粮|豆|菌|耳|枣|枸杞|粉丝|米线/;
function scoreOf(o) {
  const growth = Number(o.growth) || 0;
  const dsr = Number(o.demand_supply_ratio) || 0;
  const compRank = o.hints?.竞争小 ?? null;

  const sGrowth = Math.min(1, Math.max(0, growth) / 30);
  const sDsr = Math.min(1, Math.log10(1 + dsr) / 2);
  const sComp = compRank ? 1 - Math.min(1, compRank / 50) : 0.4;
  let base = 0.45 * sGrowth + 0.35 * sDsr + 0.2 * sComp;

  const matched = MATCH_RE.test(o.cate);
  if (matched) base += 0.1;
  const score = +(100 * Math.min(1, base)).toFixed(1);

  const reasons = [];
  if (growth < 0) reasons.push(`增速为负（${growth}%）`);
  if (dsr && dsr < 3) reasons.push(`需供比只有 ${dsr}，供给已过剩`);
  if (o.price_band?.hi != null && o.price_band.hi < 10) reasons.push("价格带上限 < ¥10，扣掉平台费没毛利空间");
  if (!o.price_band) reasons.push("拿不到价格带");

  return {
    score, matched, parts: { sGrowth: +sGrowth.toFixed(2), sDsr: +sDsr.toFixed(2), sComp: +sComp.toFixed(2), 匹配加成: matched ? 0.1 : 0 },
    excluded: reasons.length ? reasons.join("；") : null,
  };
}

const parsed = mining.map((m) => {
  let raw = {};
  try { raw = JSON.parse(m.raw || "{}"); } catch {}
  const s = scoreOf({ cate: m.category, growth: raw.growth, demand_supply_ratio: raw.demand_supply_ratio, hints: raw.hints, price_band: raw.price_band });
  return { m, raw, ...s };
});

const excluded = parsed.filter((x) => x.excluded);
const keep = parsed.filter((x) => !x.excluded).sort((a, b) => b.score - a.score).slice(0, TOP);

console.log(`\n类目机会 ${parsed.length} 个 · 排除 ${excluded.length} 个 · 入选 ${keep.length} 个\n`);
console.log(`${C.d}  分   类目                          增速    需供比  竞争小   价格带         支付金额区间${C.r}`);
for (const k of keep) {
  const r = k.raw;
  console.log(
    `  ${String(k.score).padStart(5)} ${String(k.m.category).padEnd(28).slice(0, 28)}`
    + ` ${String(r.growth ?? "—").padStart(6)}% ${String(r.demand_supply_ratio ?? "—").padStart(6)}`
    + ` ${String(r.hints?.竞争小 ?? "—").padStart(5)} ${String(r.price_band?.text || "—").padEnd(14).slice(0, 14)}`
    + ` ${r.pay_band?.text || "—"}`
  );
}
if (excluded.length) {
  console.log(`\n${C.d}被排除（不是没数据，是数不对）：${C.r}`);
  for (const e of excluded) console.log(`  ${e.m.category}：${e.excluded}`);
}

// ── 4. 候选 → 流水线 ─────────────────────────────────────
const cands = keep.map((k) => {
  const r = k.raw;
  const priceLo = r.price_band?.lo, priceHi = r.price_band?.hi;
  const priceMid = r.price_band?.mid;
  const name = `【市场机会】${k.m.category} · 增速${r.growth ?? "?"}% 需供比${r.demand_supply_ratio ?? "?"}`;

  const evidence = {
    来源: "抖店·电商罗盘 市场/行业机会",
    采集时间: k.m.fetched_at,
    类目口径: r.cate_scope || "未记录",
    机会原值: {
      成交增速: r.growth, 需求供给比: r.demand_supply_ratio,
      竞争小名次: r.hints?.竞争小 ?? null,
      成交高名次: r.hints?.成交高 ?? null,
      增速快名次: r.hints?.增速快 ?? null,
      支付金额区间: r.pay_band?.text, 最高成交价格带: r.price_band?.text,
      自然流量成交占比: r.natural_ratio?.text,
    },
    打分: { 总分: k.score, ...k.parts, 公式: "0.45·增速 + 0.35·需供比 + 0.20·竞争 + 0.10·匹配" },
    参照: { 商品榜样本: ref.样本, 价格中位: ref.价格中位, 转化率中位: ref.转化率中位, 头部店铺: ref.头部店铺 },
    区间说明: "罗盘给的是区间值；mid = 区间中点推算，未冒充精确数",
    待你补: ["拿货价 / 起订量 / 账期（问供应商，P0）", "能否同供应链复用（同厂同规格）"],
  };

  return {
    shop: SHOP,
    name,
    category: r.cate_scope || null,
    spec_idea: `价格带 ${r.price_band?.text || "—"} → 建议 2 档：试用装（贴近 ${priceLo ? y2(priceLo) : "低端"}）+ 囤货装（贴近 ${priceHi ? y2(priceHi) : "高端"}）`,
    price_idea: priceMid ?? null,
    cost_idea: null,
    score: k.score,
    evidence,
  };
});

console.log(`\n=== 产出候选 ${cands.length} 条（只到「等你确认」，不会自己上架）===`);
for (const c of cands) console.log(`  [${c.score}] ${c.name}`);

if (DRY) { console.log("\n[dry] 没写库"); process.exit(0); }

// 去重：同一类目只要还在流程里（没被拒），就不再塞新的
let added = 0, skipped = 0;
for (const c of cands) {
  const key = String(c.name).replace(/^【市场机会】([^·]+)·.*$/, "$1").trim();
  const dup = db.prepare(
    "SELECT id, stage FROM product_pipeline WHERE shop=? AND stage != 'rejected' AND name LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(SHOP, `%${key}%`);
  if (dup) { skipped++; continue; }

  const r = await fetch(`${BASE}/api/pipeline`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...c, stage: "candidate" }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e.message) }));
  if (!r.ok) { console.log(`  写入失败：${c.name} -> ${r.error || "?"}`); continue; }
  added++;
}

// 新候选立刻进 CEO 审核队列（流程规定，不是可选项）
const fresh = db.prepare("SELECT id FROM product_pipeline WHERE shop=? AND stage='candidate'").all(SHOP);
for (const f of fresh) {
  await fetch(`${BASE}/api/pipeline/${f.id}/stage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "ceo_review" }),
  }).catch(() => {});
}
console.log(`\n写入 ${added} 条新候选（跳过重复 ${skipped}），已送 CEO 审核`);

// ── 5. 打卡 + 汇报（不然选品 Agent 在台上是黑的）──────────
try {
  const total = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage != 'rejected'").get().n;
  const waitMe = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage = 'owner_confirm'").get().n;
  const topOne = cands[0]?.name || "无";
  await fetch(`${BASE}/api/reports`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: "pick",
      summary: `选品扫描：市场 ${mining.length + rankRows.length} 条样本 → 机会 ${parsed.length} 个（排除 ${excluded.length}）→ 新候选 ${added} 条。头号：${topOne}`,
      payload: { kind: "pick-scan", market: mining.length + rankRows.length, opps: parsed.length, excluded: excluded.length, added, waiting: waitMe, ref },
    }),
  });
  await fetch(`${BASE}/api/agents/pick/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      alive: true,
      metric_value: `${total} 条`, metric_label: "候选品",
      metric_extra: waitMe ? `${waitMe} 条等你确认` : `市场样本 ${mining.length + rankRows.length} 条`,
      next_run_at: new Date(Date.now() + 6 * 3600000).toISOString(),
    }),
  });
  console.log(`已打卡：候选 ${total} 条，等你确认 ${waitMe} 条`);
} catch (e) {
  console.log("打卡失败（不影响结果）：", String(e.message || e).slice(0, 80));
}
