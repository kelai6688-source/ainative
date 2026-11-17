import { db } from "./db.mjs";

const SHOP = "shop_demo";
const sets = db.prepare("SELECT * FROM settlements WHERE shop = ?").all(SHOP);
const orders = db.prepare("SELECT order_id, sku, qty, amount, income FROM orders WHERE shop = ?").all(SHOP);
const omap = new Map(orders.map((o) => [String(o.order_id), o]));

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

console.log(`审计 ${sets.length} 笔结算账单\n`);

// ① 每行恒等式：base = paid + subsidy，settle = base - |fee|
let badBase = [], badSettle = [], badRate = [];
let T = { paid: 0, subsidy: 0, base: 0, fee: 0, settle: 0 };

for (const s of sets) {
  const paid = n(s.paid), sub = n(s.subsidy), base = n(s.base), fee = Math.abs(n(s.service_fee)), settle = n(s.settle_amount);
  T.paid += paid; T.subsidy += sub; T.base += base; T.fee += fee; T.settle += settle;

  if (Math.abs(base - (paid + sub)) > 0.02) badBase.push({ id: s.order_id, paid, sub, base, diff: r2(base - paid - sub) });
  if (Math.abs(settle - (base - fee)) > 0.02) badSettle.push({ id: s.order_id, base, fee, settle, diff: r2(base - fee - settle) });

  // 账单写明的费率是 2%，检查实际扣费是否等于 base×2%
  if (base > 0) {
    const expect = base * (n(s.fee_rate) || 0);
    if (Math.abs(fee - expect) > 0.02) badRate.push({ id: s.order_id, base, fee, rate: s.fee_rate, expect: r2(expect), diff: r2(fee - expect), note: String(s.note || "").slice(0, 40) });
  }
}

console.log("① 恒等式校验");
console.log(`   base = paid + subsidy ： ${badBase.length} 笔不符 ${badBase.length ? JSON.stringify(badBase.slice(0, 3)) : "✓"}`);
console.log(`   settle = base - fee   ： ${badSettle.length} 笔不符 ${badSettle.length ? JSON.stringify(badSettle.slice(0, 3)) : "✓"}`);
console.log(`   fee = base × 2%       ： ${badRate.length} 笔不符`);
if (badRate.length) badRate.slice(0, 6).forEach((x) => console.log(`      ${x.id}  base=${x.base} fee=${x.fee} 应=${x.expect} 差=${x.diff}  ${x.note}`));

console.log("\n② 汇总");
console.log(`   用户实付合计   ¥${r2(T.paid)}`);
console.log(`   平台补贴合计   ¥${r2(T.subsidy)}`);
console.log(`   计费基数合计   ¥${r2(T.base)}`);
console.log(`   平台佣金合计   ¥${r2(T.fee)}`);
console.log(`   结算到账合计   ¥${r2(T.settle)}`);
console.log(`   验算：实付+补贴-佣金 = ¥${r2(T.paid + T.subsidy - T.fee)}  ${Math.abs(T.paid + T.subsidy - T.fee - T.settle) <= 0.05 ? "= 结算 ✓" : "≠ 结算 ✗"}`);

// ③ 标价 vs 账单
let discSum = 0, listSum = 0, miss = 0;
const perRow = [];
for (const s of sets) {
  const o = omap.get(String(s.order_id));
  if (!o) { miss++; continue; }
  const list = n(o.amount);
  const base = n(s.base);
  listSum += list;
  discSum += Math.max(0, list - base);
  perRow.push({ spec: (String(o.sku).match(/【([^】]+)】/) || [])[1] || "?", list, base, paid: n(s.paid), sub: n(s.subsidy) });
}
console.log(`\n③ 标价 vs 计费基数（只统计能在订单表里找到的 ${perRow.length} 笔，缺 ${miss} 笔）`);
console.log(`   标价合计 ¥${r2(listSum)}   计费基数合计 ¥${r2(perRow.reduce((a, b) => a + b.base, 0))}`);
console.log(`   商家承担优惠 ¥${r2(discSum)}`);
const bad = perRow.filter((x) => x.base > x.list + 0.02);
console.log(`   基数 > 标价 的行：${bad.length} 笔 ${bad.length ? JSON.stringify(bad.slice(0, 3)) : "✓（正常）"}`);

// ④ 按规格看实付分布，验证"每单实付不一样"
console.log("\n④ 各规格每单实付分布（证明用户实付确实因券而不同）");
const bySpec = new Map();
for (const x of perRow) {
  const o = bySpec.get(x.spec) || { spec: x.spec, list: [], paid: [] };
  o.list.push(x.list); o.paid.push(x.paid);
  bySpec.set(x.spec, o);
}
for (const o of bySpec.values()) {
  const uniq = [...new Set(o.paid.map((p) => r2(p)))].sort((a, b) => a - b);
  console.log(`   ${o.spec.padEnd(8)} 标价 ${[...new Set(o.list)].join("/")}  实付取值：${uniq.join(" / ")}（${uniq.length} 种）`);
}
