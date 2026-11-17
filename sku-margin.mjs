/**
 * sku-margin.mjs —— 按 SKU 精算（用结算账单的真实金额）
 *
 * 为什么要用账单：
 *   订单列表只有「商品单价」和「商家实收」，看不到「用户实付」和「平台补贴」。
 *   平台券（平台出钱）和商家券（商家出钱）必须分开，否则会把平台补贴当成自己的成本。
 *
 * 账单字段（逐笔）：
 *   用户实付 paid、平台补贴 subsidy、计费合计 base = paid + subsidy、
 *   平台服务费 service_fee（负数）、结算金额 settle_amount = base - |fee|
 * 标价来自订单表 amount。商家承担优惠 = amount - base。
 */

import fs from "node:fs";
import { db } from "./db.mjs";

const SHOP = "shop_demo";
const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const pct = (n) => `${(Number(n) || 0).toFixed(2)}%`;

const cfg = (() => {
  const raw = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
  return { ...(raw.defaults || {}), ...((raw.shops || {})[SHOP] || {}) };
})();
const items = cfg.items || {};
const shipPack = cfg.shippingPerOrder == null && cfg.packagingPerOrder == null
  ? null
  : (Number(cfg.shippingPerOrder) || 0) + (Number(cfg.packagingPerOrder) || 0);

const sets = db.prepare("SELECT * FROM settlements WHERE shop = ?").all(SHOP);
const orders = db.prepare("SELECT * FROM orders WHERE shop = ?").all(SHOP);
const omap = new Map(orders.map((o) => [String(o.order_id), o]));
const skus = db.prepare("SELECT * FROM skus WHERE shop = ?").all(SHOP);

const specOf = (s) => (String(s || "").match(/【([^】]+)】/) || [])[1] || null;
const skuBySpec = new Map();
for (const s of skus) { const k = specOf(s.spec) || String(s.spec).trim(); if (k) skuBySpec.set(k, s); }

const costOfSku = (spec) => {
  const sku = skuBySpec.get(spec);
  if (sku && items[sku.sku_id]) return { cost: Number(items[sku.sku_id]), price: sku.price };
  return null;
};

// 有些订单没抓到规格文字，用「商品单价」反查 SKU 价格表来定规格
const priceToSpec = new Map();
for (const s of skus) {
  const sp = specOf(s.spec) || String(s.spec).trim();
  if (s.price != null && sp) priceToSpec.set(Number(s.price), sp);
}
const specByAmount = (amount, qty = 1, base = null) => {
  const a = Number(amount) || 0;
  const q = Number(qty) || 1;
  if (priceToSpec.has(a)) return priceToSpec.get(a);
  if (priceToSpec.has(a / q)) return priceToSpec.get(a / q);
  // 最接近的价格（允许 1 分钱误差）
  let best = null, diff = Infinity;
  for (const [p, sp] of priceToSpec) {
    for (const cand of [a, a / q]) {
      const d = Math.abs(p - cand);
      if (d < diff) { diff = d; best = sp; }
    }
  }
  if (diff <= 0.02) return best;
  // 订单表里没有这单时（账单含更早订单），用「计费基数」去对：base ≈ 售价 或 售价-5
  if (base != null) {
    let b2 = null, d2 = Infinity;
    for (const [p, sp] of priceToSpec) {
      for (const cand of [Number(base), Number(base) + 5]) {
        const dd = Math.abs(p - cand);
        if (dd < d2) { d2 = dd; b2 = sp; }
      }
    }
    if (d2 <= 0.02) return b2;
  }
  return null;
};

console.log(`\n==== 按 SKU 精算（数据源：结算账单 ${sets.length} 笔 + 订单 ${orders.length} 单）====\n`);

const agg = new Map();
let noOrder = 0, noCost = 0;

for (const s of sets) {
  const o = omap.get(String(s.order_id));
  const rawSpec = o ? specOf(o.sku) : null;
  const spec = rawSpec || (o ? specByAmount(o.amount, o.qty) : null) || specByAmount(null, 1, s.base) || (s.item_id ? `item:${s.item_id}` : "未知");
  const qty = o ? (Number(o.qty) || 1) : 1;
  const list = o ? (Number(o.amount) || 0) : (Number(s.base) || 0);
  const paid = Number(s.paid) || 0;
  const subsidy = Number(s.subsidy) || 0;
  const base = Number(s.base) || paid + subsidy;
  const fee = Math.abs(Number(s.service_fee) || 0);
  const settle = Number(s.settle_amount) || base - fee;

  const c = costOfSku(spec);
  const cost = c ? c.cost * qty : null;
  if (!o) noOrder++;
  if (cost == null) noCost++;

  const a = agg.get(spec) || {
    spec, orders: 0, units: 0,
    list: 0, paid: 0, subsidy: 0, merchantDisc: 0, base: 0, fee: 0, settle: 0, cost: 0, costMiss: 0,
  };
  a.orders += 1;
  a.units += qty;
  a.list += list;
  a.paid += paid;
  a.subsidy += subsidy;
  a.merchantDisc += Math.max(0, list - base);
  a.base += base;
  a.fee += fee;
  a.settle += settle;
  if (cost == null) a.costMiss += qty; else a.cost += cost;
  agg.set(spec, a);
}

const rows = [...agg.values()].sort((a, b) => b.settle - a.settle);

console.log("规格        单数 件数  标价合计   用户实付   平台补贴   商家承担券  计费基数   佣金2%   结算到账   拿货     毛利      毛利率");
for (const a of rows) {
  const gross = a.costMiss ? null : a.settle - a.cost - (shipPack != null ? shipPack * a.orders : 0);
  const rate = gross != null && a.settle > 0 ? (gross / a.settle) * 100 : null;
  console.log(
    `${a.spec.padEnd(10)}${String(a.orders).padStart(4)} ${String(a.units).padStart(4)}  ${y(a.list).padStart(9)}  ${y(a.paid).padStart(9)}  ${y(a.subsidy).padStart(8)}  ${y(a.merchantDisc).padStart(9)}  ${y(a.base).padStart(9)}  ${y(a.fee).padStart(7)}  ${y(a.settle).padStart(9)}  ${y(a.cost).padStart(8)}  ${(gross == null ? "缺成本" : y(gross)).padStart(9)}  ${rate == null ? "—" : pct(rate)}`
  );
}

// 合计校验：结算 = 基数 - 佣金
const T = rows.reduce((s, a) => ({
  orders: s.orders + a.orders, units: s.units + a.units,
  list: s.list + a.list, paid: s.paid + a.paid, subsidy: s.subsidy + a.subsidy,
  disc: s.disc + a.merchantDisc, base: s.base + a.base, fee: s.fee + a.fee,
  settle: s.settle + a.settle, cost: s.cost + a.cost,
}), { orders: 0, units: 0, list: 0, paid: 0, subsidy: 0, disc: 0, base: 0, fee: 0, settle: 0, cost: 0 });

console.log(`\n合计：${T.orders} 单 / ${T.units} 件`);
console.log(`  标价合计      ${y(T.list)}`);
console.log(`  用户实付      ${y(T.paid)}   （买家真掏的钱）`);
console.log(`  平台补贴      ${y(T.subsidy)}   （平台出，不算你成本）`);
console.log(`  商家承担券    ${y(T.disc)}   （你出）`);
console.log(`  计费基数      ${y(T.base)}  = 实付 + 补贴`);
console.log(`  平台佣金      ${y(T.fee)}  = 基数 × 2%`);
console.log(`  结算到账      ${y(T.settle)}  = 基数 - 佣金`);
console.log(`  拿货成本      ${y(T.cost)}`);
console.log(`  毛利          ${y(T.settle - T.cost)}   （未扣物流/投放）`);

console.log(`\n校验：基数 - 佣金 = ${y(T.base - T.fee)}，账单结算合计 = ${y(T.settle)} → ${Math.abs((T.base - T.fee) - T.settle) < 0.05 ? "一致 ✓" : "不一致 ✗"}`);
console.log(`覆盖：账单 ${sets.length} 笔 / 订单 ${orders.length} 单；缺订单 ${noOrder} 笔，缺成本 ${noCost} 笔`);
console.log(`物流：${shipPack == null ? "未填（包邮就填 0）" : y(shipPack) + "/单"}`);

// 每单平均到手，按规格
console.log(`\n每单平均（按规格）：`);
for (const a of rows) {
  if (!a.orders) continue;
  console.log(`  ${a.spec.padEnd(10)} 实付 ${y(a.paid / a.orders)} / 到手 ${y(a.settle / a.orders)} / 成本 ${y(a.cost / a.orders)} → 每单毛利 ${y((a.settle - a.cost) / a.orders)}`);
}
