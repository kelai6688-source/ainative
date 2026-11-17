import fs from "node:fs";
/**
 * select-products.mjs —— 自动选品分析：从真实数据里挑「值得做的品」
 *
 * 它怎么判（全部可复算，不许拍脑袋）：
 *   ① 现有品里，哪些规格毛利率高、且量够 → 值得加大投入或做同款
 *   ② 哪些规格毛利率低还占着曝光 → 该淘汰/改规格
 *   ③ 退款率高的品 → 不碰同款
 *
 * 数据边界（明说）：
 *   现在没有外部选品数据源（抖音选品广场、蝉妈妈这类），
 *   所以「市场上什么好卖」它判断不了，只能判断「你自己店里什么结构值得复制」。
 *   要真正对外选品，得先接一个外部数据源，这是下一步。
 *
 * 用法：
 *   node select-products.mjs            # 分析并写入候选
 *   node select-products.mjs --dry      # 只看结论不写库
 */

import { db } from "./db.mjs";

const SHOP = "shop_demo";
const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const DRY = process.argv.includes("--dry");
const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

// ── 事实：按规格汇总（用结算账单真实钱）────────────────
const sets = db.prepare("SELECT * FROM settlements WHERE shop = ?").all(SHOP);
const orders = db.prepare("SELECT * FROM orders WHERE shop = ?").all(SHOP);
const skus = db.prepare("SELECT * FROM skus WHERE shop = ?").all(SHOP);
const cfgRaw = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
const CONF = { ...(cfgRaw.defaults || {}), ...((cfgRaw.shops || {})[SHOP] || {}) };
const items = CONF.items || {};

const specOf = (s) => (String(s || "").match(/【([^】]+)】/) || [])[1] || null;
const skuBySpec = new Map();
for (const s of skus) { const k = specOf(s.spec) || String(s.spec).trim(); if (k) skuBySpec.set(k, s); }

const omap = new Map(orders.map((o) => [String(o.order_id), o]));
const agg = new Map();
for (const s of sets) {
  const o = omap.get(String(s.order_id));
  const spec = o ? (specOf(o.sku) || "未知") : "未知";
  const qty = o ? Number(o.qty) || 1 : 1;
  const sku = skuBySpec.get(spec);
  const cost = sku && items[sku.sku_id] ? Number(items[sku.sku_id]) * qty : null;
  const a = agg.get(spec) || { spec, orders: 0, units: 0, paid: 0, settle: 0, cost: 0, miss: 0, price: sku ? sku.price : null };
  a.orders += 1; a.units += qty;
  a.paid += Number(s.paid) || 0;
  a.settle += Number(s.settle_amount) || 0;
  if (cost == null) a.miss += qty; else a.cost += cost;
  agg.set(spec, a);
}

// 退款（用快照的 30 天退款额，全店口径）
const refund = db.prepare("SELECT value FROM metric_snapshots WHERE agent_id=? AND win='近30天' AND label='退款金额'").get(SHOP);
const refundAmt = refund ? Number(String(refund.value).replace(/[^\d.]/g, "")) : null;

console.log(`\n=== 选品分析 · ${SHOP} ===`);
console.log(`数据：账单 ${sets.length} 笔 / 订单 ${orders.length} 单 / SKU ${skus.length} 条\n`);

const rows = [...agg.values()].map((a) => {
  const gross = a.miss ? null : a.settle - a.cost;
  const rate = gross != null && a.settle > 0 ? (gross / a.settle) * 100 : null;
  return { ...a, gross, rate, perOrder: a.orders ? a.settle / a.orders : 0, costPer: a.units ? a.cost / a.units : null };
}).sort((x, y2) => (y2.gross || 0) - (x.gross || 0));

console.log("规格      单数  件数  到手      拿货     毛利      毛利率");
for (const r of rows) {
  console.log(`${r.spec.padEnd(9)}${String(r.orders).padStart(4)}  ${String(r.units).padStart(4)}  ${y(r.settle).padStart(8)}  ${y(r.cost).padStart(7)}  ${(r.gross == null ? "缺成本" : y(r.gross)).padStart(8)}  ${r.rate == null ? "—" : r.rate.toFixed(1) + "%"}`);
}
if (refundAmt) console.log(`\n近30天退款 ${y(refundAmt)}（全店口径，未按规格拆）`);

// ── 结论 → 候选 ───────────────────────────────────
const cands = [];
for (const r of rows) {
  if (r.rate == null) continue;
  if (r.rate >= 33 && r.orders >= 5) {
    cands.push({
      name: `放量/复制：${r.spec}`,
      category: "粮油干货/方便速食>方便速食>面皮/面饼",
      spec_idea: `${r.spec}（同结构换长尾词或换口味）`,
      price_idea: r.price,
      cost_idea: r.costPer,
      score: +(r.rate * Math.log10(r.orders + 1)).toFixed(1),
      evidence: {
        依据: "本店真实结算数据",
        单数: r.orders, 件数: r.units,
        到手: +r.settle.toFixed(2), 拿货: +r.cost.toFixed(2),
        每单毛利: r.orders ? +((r.gross / r.orders)).toFixed(2) : null,
        毛利率: +r.rate.toFixed(1),
        判定: `毛利率 ${r.rate.toFixed(1)}% ≥ 33% 且卖出 ${r.orders} 单 → 值得复制`,
      },
    });
  }
  if (r.rate < 25 && r.orders >= 5) {
    cands.push({
      name: `改造/淘汰：${r.spec}`,
      category: "粮油干货/方便速食>方便速食>面皮/面饼",
      spec_idea: `提价或改规格（当前每单毛利 ${y(r.gross / r.orders)}）`,
      price_idea: r.price,
      cost_idea: r.costPer,
      score: +((33 - r.rate) * Math.log10(r.orders + 1)).toFixed(1),
      evidence: {
        依据: "本店真实结算数据",
        单数: r.orders, 毛利率: +r.rate.toFixed(1),
        判定: `毛利率 ${r.rate.toFixed(1)}% < 25%，卖得多赚得少 → 该改`,
      },
    });
  }
}

console.log(`\n=== 候选 ${cands.length} 条 ===`);
for (const c of cands) {
  console.log(`  [${c.score}] ${c.name}`);
  console.log(`      ${c.evidence.判定}`);
}

console.log(`\n数据边界：没有外部选品数据源（选品广场/蝉妈妈），
所以只判断「你自己店里什么结构值得复制」，判断不了「市场上什么最好卖」。
要对外选品，得先接一个外部数据源。`);

if (DRY) { console.log("\n[dry] 没写库"); process.exit(0); }

// 去重后写入
let added = 0;
for (const c of cands) {
  // 被否决过的也算「处理过」，别再重复塞进来\n  const dup = db.prepare("SELECT id,stage FROM product_pipeline WHERE shop=? AND name=? ORDER BY id DESC LIMIT 1").get(SHOP, c.name);
  if (dup) continue;
  const r = await fetch(`${BASE}/api/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop: SHOP, name: c.name, category: c.category, spec_idea: c.spec_idea, price_idea: c.price_idea, cost_idea: c.cost_idea, evidence: c.evidence, score: c.score }),
  });
  if (r.ok) added++;
}

// 新候选直接进 CEO 审核（这是流程规定，不是可选项）
const fresh = db.prepare("SELECT id FROM product_pipeline WHERE shop=? AND stage='candidate'").all(SHOP);
for (const f of fresh) {
  await fetch(`${BASE}/api/pipeline/${f.id}/stage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "ceo_review" }),
  });
}

console.log(`\n写入 ${added} 条新候选，已送 CEO 审核队列`);

// ── 给「自动选品 Agent」打卡 + 写汇报（否则卡片一直显示没汇报、逾期）──
try {
  const total = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage != 'rejected'").get().n;
  const waitMe = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage = 'owner_confirm'").get().n;
  const mkt = db.prepare("SELECT COUNT(*) n FROM market_items").get().n;
  await fetch(`${BASE}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: "pick",
      summary: `选品扫描：市场样本 ${mkt} 条，产出候选 ${total} 条，其中 ${waitMe} 条已过 CEO 审等你确认`,
      payload: { kind: "pick-scan", market: mkt, candidates: total, waiting: waitMe, at: new Date().toISOString() },
    }),
  });
  await fetch(`${BASE}/api/agents/pick/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metric_value: `${total} 条`, metric_label: "候选品", metric_extra: waitMe ? `${waitMe} 条等你确认` : `市场样本 ${mkt} 条` }),
  });
  console.log(`已给选品 Agent 打卡：候选 ${total} 条，等你确认 ${waitMe} 条`);
} catch (e) {
  console.log("打卡失败（不影响结果）：", String(e.message || e).slice(0, 80));
}