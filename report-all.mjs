/**
 * report-all.mjs —— 全量重算（口径每一条都标来源）
 *
 * 数据来源：
 *   订单明细  抖店订单页（翻页抓全，已 500 单）
 *   类目费率  抖店结算账单（备注列，2.00%，10 笔样本）
 *   指标      抖店首页快照（实时/近7天/近30天各一份）
 *   拿货成本  你自己填的 27 个 SKU
 *   物流包装  你还没填（=0，会标出来）
 */

import fs from "node:fs";
import { db } from "./db.mjs";

const SHOP = "shop_demo";
const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const pct = (n) => `${(Number(n) || 0).toFixed(2)}%`;
const d = (s) => String(s || "").slice(0, 10);
const todayStr = new Date().toLocaleDateString("sv-SE");
const daysAgo = (k) => new Date(Date.now() - k * 86400000).toLocaleDateString("sv-SE");

// ── 配置 ───────────────────────────────────────────────
const cfgRaw = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
const cfg = { ...(cfgRaw.defaults || {}), ...((cfgRaw.shops || {})[SHOP] || {}) };
const items = cfg.items || {};
const shipPack = (Number(cfg.shippingPerOrder) || 0) + (Number(cfg.packagingPerOrder) || 0);
const payRate = Number(cfg.paymentFeeRate) || 0;

// 费率（账单实查优先）
const feeRows = db.prepare("SELECT * FROM fee_rates WHERE shop = ? ORDER BY samples DESC").all(SHOP);
const feeRate = feeRows.length ? Number(feeRows[0].rate) : 0;

// ── 数据 ───────────────────────────────────────────────
const allOrders = db.prepare("SELECT * FROM orders WHERE shop = ?").all(SHOP);
const okOrders = allOrders.filter((r) => !/关闭|取消|退款/.test(r.status || ""));
const skus = db.prepare("SELECT * FROM skus WHERE shop = ?").all(SHOP);
const snapRows = db.prepare("SELECT * FROM metric_snapshots WHERE agent_id = ?").all(SHOP);

const specOf = (s) => (String(s || "").match(/【([^】]+)】/) || [])[1] || null;
const skuBySpec = new Map();
for (const s of skus) { const k = specOf(s.spec) || String(s.spec || "").trim(); if (k) skuBySpec.set(k, s); }
const costOf = (o) => {
  const spec = specOf(o.sku);
  const sku = spec ? skuBySpec.get(spec) : null;
  if (sku && items[sku.sku_id]) return Number(items[sku.sku_id]);
  if (o.item_id && items[o.item_id]) return Number(items[o.item_id]);
  return null;
};

const snap = (win, label) => {
  const rows = snapRows.filter((r) => r.win === win);
  const m = rows.find((r) => r.label === label);
  if (!m) return null;
  if (m.value === "-") return null;
  return m.ok ? Number(String(m.value).replace(/[^\d.-]/g, "")) : null;
};

function calc(fromDay, label, winForAd) {
  const rows = okOrders.filter((r) => d(r.created_at) >= fromDay);
  const n = rows.length;
  const paid = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const income = rows.reduce((s, r) => s + (r.income != null ? Number(r.income) : Number(r.amount) || 0), 0);
  const units = rows.reduce((s, r) => s + (Number(r.qty) || 1), 0);

  const discount = Math.max(0, paid - income);
  const commission = paid * feeRate;
  let goods = 0, missing = 0;
  for (const r of rows) {
    const c = costOf(r);
    const q = Number(r.qty) || 1;
    if (c == null) { missing += q; continue; }
    goods += c * q;
  }
  const logistics = shipPack * n;
  const payFee = income * payRate;
  const adSpend = winForAd ? (snap(winForAd, "投放消耗") || 0) : 0;
  const refund = winForAd ? (snap(winForAd, "退款金额") || 0) : null;

  const costOk = missing === 0 && n > 0;
  const profit = costOk ? income - commission - payFee - goods - logistics - adSpend : null;
  const margin = profit != null && income > 0 ? (profit / income) * 100 : null;

  return {
    label, n, units, paid, income, discount, commission, goods, missing, logistics, payFee, adSpend, refund,
    profit, margin, avgOrder: n ? profit / n : null,
    breakEvenRoi: margin && margin > 0 ? 100 / margin : null,
    aov: n ? paid / n : 0,
  };
}

const WINS = [
  ["实时（今天）", todayStr, "实时"],
  ["近7天", daysAgo(6), "近7天"],
  ["近30天", daysAgo(29), "近30天"],
  ["全部（库内）", "2000-01-01", null],
];

console.log(`\n==== 示例店铺 · 全量重算 · ${todayStr} ====\n`);
const span = db.prepare("SELECT MIN(created_at) a, MAX(created_at) b FROM orders WHERE shop = ?").get(SHOP);
console.log(`数据：订单明细 ${allOrders.length} 单（有效 ${okOrders.length}）  日期 ${d(span.a)} ~ ${d(span.b)}   （后台共 713 单，已抓最近 ${allOrders.length}）`);
console.log(`费率：${feeRate ? pct(feeRate * 100) + "（账单实查，" + feeRows[0].samples + " 笔）" : "未知"}`);
console.log(`物流包装：${shipPack === 0 ? "未填（=0，毛利偏高）" : y(shipPack) + "/单"}`);
console.log(`拿货成本：${Object.keys(items).length} 个 SKU 已填\n`);

const results = WINS.map(([label, from, adWin]) => calc(from, label, adWin));

console.log("窗口          订单   件数   买家支付    商家收入   优惠分摊   佣金(2%)  拿货     毛利       毛利率    单均     保本ROI");
for (const r of results) {
  console.log(
    `${r.label.padEnd(13)}${String(r.n).padStart(4)}  ${String(r.units).padStart(4)}  ${y(r.paid).padStart(9)}  ${y(r.income).padStart(9)}  ${y(r.discount).padStart(8)}  ${y(r.commission).padStart(7)}  ${y(r.goods).padStart(7)}  ${(r.profit == null ? "不可算" : y(r.profit)).padStart(9)}  ${(r.margin == null ? "—" : pct(r.margin)).padStart(7)}  ${(r.avgOrder == null ? "—" : y(r.avgOrder)).padStart(7)}  ${r.breakEvenRoi ? r.breakEvenRoi.toFixed(2) : "—"}`
  );
}

// 按 SKU（近30天）
const from30 = daysAgo(29);
const rows30 = okOrders.filter((r) => d(r.created_at) >= from30);
const bySpec = new Map();
for (const r of rows30) {
  const spec = specOf(r.sku) || "未知";
  const q = Number(r.qty) || 1;
  const rev = r.income != null ? Number(r.income) : Number(r.amount) || 0;
  const c = costOf(r);
  const o = bySpec.get(spec) || { spec, units: 0, rev: 0, cost: 0, miss: 0 };
  o.units += q; o.rev += rev;
  if (c == null) o.miss += q; else o.cost += c * q;
  bySpec.set(spec, o);
}
console.log(`\n【按 SKU · 近30天】（未扣物流/投放）`);
const skuRows = [...bySpec.values()].sort((a, b) => b.rev - a.rev);
for (const o of skuRows) {
  const gross = o.miss ? null : o.rev - o.cost;
  const rate = gross != null && o.rev > 0 ? (gross / o.rev) * 100 : null;
  console.log(`  ${o.spec.padEnd(10)} ${String(o.units).padStart(3)} 件  收入 ${y(o.rev).padStart(9)}  拿货 ${y(o.cost).padStart(8)}  毛利 ${(gross == null ? "缺成本" : y(gross)).padStart(9)}  ${rate == null ? "" : pct(rate)}`);
}

// 物流敏感度（近30天）
const base30 = results.find((r) => r.label === "近30天");
if (base30 && base30.profit != null) {
  console.log(`\n【物流敏感度 · 近30天】每单快递+包装填多少，毛利变成：`);
  for (const v of [0, 2, 3, 3.5, 4, 5]) {
    const p = base30.profit - v * base30.n;
    const m = base30.income > 0 ? (p / base30.income) * 100 : 0;
    console.log(`  每单 ${String(v).padEnd(4)} 元 → 毛利 ${y(p).padStart(9)}　毛利率 ${pct(m)}`);
  }
}

// 退款
const refund30 = snap("近30天", "退款金额");
if (refund30 != null) {
  const gmv30 = snap("近30天", "成交金额") || 0;
  console.log(`\n【退款 · 近30天】退款 ${y(refund30)}　占成交 ${gmv30 ? pct((refund30 / gmv30) * 100) : "?"}`);
}
