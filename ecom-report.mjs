#!/usr/bin/env node
/* ecom-report.mjs —— 电商经营综合报告（同一口径：全部按订单明细算）
 *
 *   node ecom-report.mjs                 # 默认今天
 *   node ecom-report.mjs --window 7d     # 近 7 天
 *   node ecom-report.mjs --window all    # 全部
 *   node ecom-report.mjs --shop shop_demo --dry
 *
 * 口径纪律（上一版就是这里出的错）：
 *   · 收入、成本、单量必须来自**同一个时间窗**，否则毛利率会算成 -500%
 *   · 抖店「商家收入」里平台已经扣过佣金，不能再减一次类目扣点（重复扣费）
 *   · 类目扣点只在「没有商家收入数据」时用来估算
 *   · 后台首页那几个数只用来**交叉核对**，不直接参与利润计算
 */

import fs from "node:fs";
import { db } from "./db.mjs";
import { postJSON, getJSON } from "./connectors/_http.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const arg = (n, d = null) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SHOP = arg("shop", "shop_demo");
const WINDOW = arg("window", "today");

const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const pct = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const today = () => new Date().toLocaleDateString("sv-SE");

// ── 参数（按店铺） ───────────────────────────────────────
const cfg = (() => {
  const dflt = { categoryFeeRate: 0, paymentFeeRate: 0.006, shippingPerOrder: 0, packagingPerOrder: 0, skus: [] };
  try {
    const j = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
    return { ...dflt, ...(j.defaults || {}), ...((j.shops || {})[SHOP] || {}) };
  } catch { return dflt; }
})();

// ── 时间窗 ─────────────────────────────────────────────
const from = (() => {
  const t = today();
  if (WINDOW === "all") return "0000-00-00";
  if (WINDOW === "7d") return new Date(Date.now() - 6 * 86400000).toLocaleDateString("sv-SE");
  if (/^\d{4}-\d{2}-\d{2}$/.test(WINDOW)) return WINDOW;
  return t;   // today
})();

const all = db.prepare("SELECT * FROM orders WHERE shop = ? ORDER BY coalesce(created_at,'') DESC").all(SHOP);
const rows = all.filter((r) => String(r.created_at || "").slice(0, 10) >= from);
const okRows = rows.filter((r) => !/关闭|取消|退款/.test(r.status || ""));

// ── 收入（订单口径）────────────────────────────────────
const gmv = okRows.reduce((n, r) => n + (Number(r.amount) || 0), 0);          // 买家支付
const incomeSum = okRows.reduce((n, r) => n + (r.income != null ? Number(r.income) : (Number(r.amount) || 0)), 0);
const refundRows = rows.filter((r) => /退款|关闭|取消/.test(r.status || ""));
const refundAmt = refundRows.reduce((n, r) => n + (Number(r.amount) || 0), 0);
const orderN = okRows.length;
const platformsTook = gmv - incomeSum;                                        // 平台已扣（佣金/优惠分摊）
const hasIncome = okRows.some((r) => r.income != null);

// 没有商家收入数据时才用配置的扣点估
const feeRate = Number(cfg.categoryFeeRate) || 0;
const payRate = Number(cfg.paymentFeeRate) || 0;
const estimatedFee = hasIncome ? 0 : gmv * feeRate;
const payFee = incomeSum * payRate;

// ── 成本（同一窗口）────────────────────────────────────
const costOf = (sku) => {
  const hit = (cfg.skus || [])
    .filter((s) => s.match && String(sku || "").includes(s.match) && Number(s.cost) > 0)
    .sort((a, b) => String(b.match).length - String(a.match).length)[0];
  return hit ? Number(hit.cost) : null;
};
let goods = 0, unitsOk = 0, unitsAll = 0;
const missing = [];
for (const r of okRows) {
  const q = Number(r.qty) || 1;
  unitsAll += q;
  const c = costOf(r.sku);
  if (c === null) { missing.push((r.sku || "未知").slice(0, 22)); continue; }
  goods += c * q; unitsOk += q;
}
const logistics = (Number(cfg.shippingPerOrder) || 0) * orderN + (Number(cfg.packagingPerOrder) || 0) * orderN;
const costReady = unitsAll > 0 && unitsOk > 0 && goods > 0;

// ── 投放（后台口径，只做效率判断）──────────────────────
const st = (await getJSON(`${BASE}/api/state`)).body;
const sub = (label) => {
  const m = (st.submetrics || []).find((x) => x.agent_id === SHOP && x.label === label);
  return m && m.ok && m.value != null ? Number(String(m.value).replace(/[^\d.-]/g, "")) : null;
};
const adSpend = sub("投放消耗") ?? 0;
const adRatioDash = sub("投放费比");
const views = sub("商品曝光") ?? 0;
const clicks = sub("商品点击") ?? 0;
const buyers = sub("成交人数") ?? 0;
const shortVideo = sub("短视频成交") ?? 0;
const live = sub("直播引流成交") ?? 0;

// ── 利润 ───────────────────────────────────────────────
const netRevenue = incomeSum - payFee - refundAmt - estimatedFee;
const profit = costReady ? netRevenue - goods - logistics - adSpend : null;
const margin = profit !== null && incomeSum > 0 ? (profit / incomeSum) * 100 : null;
const perOrder = profit !== null && orderN ? profit / orderN : null;
const realAdRatio = incomeSum > 0 ? (adSpend / incomeSum) * 100 : 0;
const roi = adSpend > 0 ? gmv / adSpend : null;
const breakEvenRoi = margin && margin > 0 ? 100 / margin : null;

// ── 结构 / 漏斗 ────────────────────────────────────────
const card = Math.max(0, gmv - shortVideo - live);
const channels = [
  { name: "商品卡", amt: card }, { name: "短视频", amt: shortVideo }, { name: "直播", amt: live },
].map((c) => ({ ...c, share: gmv > 0 ? (c.amt / gmv) * 100 : 0 })).sort((a, b) => b.amt - a.amt);
const ctr = views > 0 ? (clicks / views) * 100 : null;
const cvr = clicks > 0 ? (buyers / clicks) * 100 : null;

// ── 按款 ───────────────────────────────────────────────
const bySku = new Map();
for (const r of okRows) {
  const k = (r.sku || "未知").slice(0, 30);
  const o = bySku.get(k) || { sku: k, n: 0, gmv: 0, income: 0, cost: 0, costed: true };
  o.n += Number(r.qty) || 1;
  o.gmv += Number(r.amount) || 0;
  o.income += r.income != null ? Number(r.income) : (Number(r.amount) || 0);
  const c = costOf(r.sku);
  if (c === null) o.costed = false; else o.cost += c * (Number(r.qty) || 1);
  bySku.set(k, o);
}
const skuList = [...bySku.values()].map((o) => ({
  ...o,
  profit: o.costed ? o.income - o.cost : null,
  margin: o.costed && o.income > 0 ? ((o.income - o.cost) / o.income) * 100 : null,
})).sort((a, b) => b.gmv - a.gmv);

// ── 结论 ───────────────────────────────────────────────
const findings = [];
const escalations = [];
const winLabel = WINDOW === "today" ? "今天" : WINDOW === "7d" ? "近 7 天" : WINDOW === "all" ? "全部订单" : WINDOW;

if (!rows.length) {
  console.log(`\n${SHOP} 在「${winLabel}」没有任何订单。换个窗口：--window 7d / all\n`);
  process.exit(0);
}
if (!hasIncome) findings.push({ lv: "info", t: "订单里没有「商家收入」，平台扣费按你填的类目扣点估算" });
if (!costReady) findings.push({ lv: "info", t: `成本没配全（${unitsAll - unitsOk} 件缺成本）—— 毛利算不出来` });

if (profit !== null) {
  if (profit < 0) {
    findings.push({ lv: "bad", t: `${winLabel}是亏的：净亏 ${y(Math.abs(profit))}（毛利率 ${pct(margin)}）` });
    escalations.push({
      title: `电商${winLabel}净亏 ${y(Math.abs(profit))}，要不要停投/调价`,
      recommendation: "先停投放，把费比压到毛利率以下；再查是哪个款拖累",
      cost: `按当前成本，每单亏 ${y(Math.abs(perOrder || 0))}`,
      scope: "只动投放与 1 个款的价格",
      silent_default: "不回 = 继续按现状卖。",
    });
  } else {
    findings.push({ lv: "ok", t: `${winLabel}毛利 ${y(profit)}（毛利率 ${pct(margin)}，单均 ${y(perOrder)}）` });
  }
}
if (adSpend > 0 && margin !== null && margin > 0 && realAdRatio > margin) {
  findings.push({ lv: "bad", t: `投放费比 ${pct(realAdRatio)} > 毛利率 ${pct(margin)} —— 投一单亏一单` });
  escalations.push({
    title: `投放费比 ${pct(realAdRatio)} 高于毛利率 ${pct(margin)}，要不要停投`,
    recommendation: "停掉这笔投放，或把出价压到保本 ROI 以内",
    cost: `${winLabel}投放 ${y(adSpend)}，换回 ${y(gmv)} 成交`,
    scope: "只停这一个计划",
    silent_default: "不回 = 继续投。",
  });
}
if (channels[0] && channels[0].share >= 90 && gmv > 0) {
  findings.push({ lv: "warn", t: `成交 ${channels[0].share.toFixed(0)}% 来自「${channels[0].name}」，结构单一` });
  escalations.push({
    title: `成交 ${channels[0].share.toFixed(0)}% 靠「${channels[0].name}」，要不要补第二条渠道`,
    recommendation: "短视频和直播各试 3 条，预算从现有投放挪 20%",
    cost: "只挪预算，不加钱",
    scope: "只挪预算",
    silent_default: "不回 = 维持单渠道。",
  });
}
const losers = skuList.filter((s) => s.profit !== null && s.profit < 0);
if (losers.length) findings.push({ lv: "bad", t: `${losers.length} 个款在亏钱：${losers.map((s) => s.sku.slice(0, 12)).join("、")}` });
if (ctr !== null && ctr < 2) findings.push({ lv: "warn", t: `曝光→点击 ${pct(ctr)}，主图/标题留不住人` });
if (cvr !== null && cvr < 20) findings.push({ lv: "warn", t: `点击→成交 ${pct(cvr)}，详情/价格劝退` });
const aftersale = sub("售后待处理");
if (aftersale > 0) findings.push({ lv: "bad", t: `售后待处理 ${aftersale} 单（超时有罚款）` });

// ── 打印 ───────────────────────────────────────────────
console.log(`\n=== 电商经营报告 · ${SHOP} · ${winLabel}（${from} 起）===\n`);
console.log(`【单量】${orderN} 单（另 ${refundRows.length} 单关闭/退款）`);
console.log(`【收入】买家支付 ${y(gmv)}　商家收入 ${y(incomeSum)}　退款 ${y(refundAmt)}`);
console.log(`        平台已扣 ${y(platformsTook)}${hasIncome ? "（来自商家收入差）" : "（按扣点估算）"}`);
console.log(`【成本】拿货 ${costReady ? y(goods) : "未配置"}　物流+包装 ${logistics ? y(logistics) : "未配置"}`);
console.log(`【投放】${y(adSpend)}　费比 ${pct(realAdRatio)}${roi ? `　ROI ${roi.toFixed(2)}` : ""}${breakEvenRoi ? `　保本 ROI ${breakEvenRoi.toFixed(2)}` : ""}`);
console.log(`【结构】` + channels.map((c) => `${c.name} ${y(c.amt)}(${c.share.toFixed(0)}%)`).join("　"));
console.log(`【漏斗】曝光 ${views} → 点击 ${clicks}（${ctr === null ? "—" : pct(ctr)}）→ 成交 ${buyers}（${cvr === null ? "—" : pct(cvr)}）`);
console.log(`【利润】` + (profit === null ? "算不出来（缺成本）" : `毛利 ${y(profit)}　毛利率 ${pct(margin)}　单均 ${y(perOrder)}`));
if (skuList.length) {
  console.log(`\n按款：`);
  skuList.slice(0, 6).forEach((s) => console.log(
    `  ${y(s.gmv).padStart(9)}  ${String(s.n).padStart(2)} 件  ${s.profit === null ? "  成本缺  " : `${y(s.profit).padStart(9)} ${pct(s.margin).padStart(8)}`}  ${s.sku}`
  ));
}
console.log(`\n结论：`);
findings.forEach((f) => console.log(`  ${{ bad: "✗", warn: "!", ok: "✓", info: "·" }[f.lv]} ${f.t}`));
console.log(escalations.length ? `\n必须你定（${escalations.length}）：` : `\n没有需要你拍板的事。`);
escalations.forEach((e) => console.log(`  [P0] ${e.title}`));

if (DRY) { console.log(`\n[dry] 没写库。`); process.exit(0); }

const summary =
  `${winLabel}：${orderN} 单，买家支付 ${y(gmv)}、商家收入 ${y(incomeSum)}；` +
  `投放 ${y(adSpend)}（费比 ${pct(realAdRatio)}）；` +
  (profit === null ? "毛利未算（缺成本）" : `毛利 ${y(profit)}（${pct(margin)}）`) + "。" +
  findings.filter((f) => f.lv !== "ok").map((f) => f.t).join("；");

const r = await postJSON(`${BASE}/api/reports`, {
  agent_id: SHOP, summary,
  payload: {
    window: WINDOW, from, orderN, gmv, incomeSum, refundAmt, platformsTook,
    goods: costReady ? goods : null, logistics, adSpend, realAdRatio, roi, breakEvenRoi,
    profit, margin, perOrder, channels, ctr, cvr, costReady, escalating: escalations.length,
    skus: skuList.slice(0, 8),
  },
});
console.log(`\n汇报已写：${r.ok ? "ok" : r.body?.error || r.error}`);

for (const e of escalations) {
  const dup = st.decisions.some((d) => d.question === e.title && d.answer == null);
  if (dup) { console.log(`  跳过（已在桌上）：${e.title}`); continue; }
  const c = await postJSON(`${BASE}/api/cards`, {
    title: `【上报】${e.title}`, why: "电商 Agent 分析结论：超出权限，必须你定",
    deliverable: e.recommendation, done_def: "你批了之后按范围执行", level: "P0",
    owner: "shop", check_day: 2, actor: "ecom-report",
  });
  if (!c.ok) { console.log(`  上报失败：${c.body?.error || c.error}`); continue; }
  const d = await postJSON(`${BASE}/api/cards/${c.body.id}/request-decision`, {
    question: e.title, recommendation: e.recommendation, cost: e.cost,
    scope: e.scope, silent_default: e.silent_default, asked_by: "shop",
  });
  console.log(d.ok ? `  上报决策包 #${d.body.decision_id}：${e.title}` : `  决策包失败：${d.body?.error}`);
}
