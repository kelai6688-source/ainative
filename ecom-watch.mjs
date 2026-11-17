#!/usr/bin/env node
/* ecom-watch.mjs —— 看电商 Agent 现在在想什么（一屏看完，不用翻库）
 *
 *   node ecom-watch.mjs
 */

import { getJSON } from "./connectors/_http.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const st = (await getJSON(`${BASE}/api/state`)).body;
const shops = (await getJSON(`${BASE}/api/shops`)).body.shops || [];
const prods = (await getJSON(`${BASE}/api/products?shop=shop_demo`)).body.products || [];
const link = (await getJSON(`${BASE}/api/orders/stats?shop=shop_demo`)).body;

const node = (id) => st.agents.find((a) => a.id === id) || {};
const subs = st.submetrics.filter((m) => m.agent_id === "shop_demo");
const val = (label) => {
  const m = subs.find((x) => x.label === label);
  return m && m.ok && m.value != null && m.value !== "" ? m.value : "—";
};
const ago = (iso) => {
  if (!iso) return "没跑过";
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
};

console.log(`\n==== 电商 Agent 运转状态 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ====\n`);

const shop = shops.find((s) => s.agent === "shop_demo") || {};
console.log(`【店铺】${shop.platform_name || ""} · ${shop.name || "shop_demo"}`);
console.log(`  连接 ${shop.alive ? "[OK] 正常" : "[X] 断开"} · 参数 ${shop.params_ready ? "[OK] 已填" : "[X] 待填"} · 更新 ${ago(shop.last_run_at)}`);
console.log(`  订单 ${link.total?.n ?? 0} 单 / ¥${link.total?.amt ?? 0} · 商品 ${prods.length} 个`);

console.log(`\n【实时指标】（每 5 分钟刷）`);
for (const g of [["待发货", "售后待处理", "成交订单数", "成交人数"],
                 ["商品曝光", "商品点击", "曝点转化率", "点击成交率"],
                 ["用户支付金额", "客单价", "投放消耗", "投放费比"],
                 ["短视频成交", "直播引流成交", "搜索支付金额", "退款金额"]]) {
  console.log("  " + g.map((k) => `${k} ${String(val(k)).padEnd(7)}`).join("  "));
}

console.log(`\n【商品清单】（成本按商品ID记）`);
for (const p of prods.slice(0, 10)) {
  console.log(`  ${p.item_id}  ${String(p.price_min ?? "?")}~${String(p.price_max ?? "?")}  ${p.status || ""}  ${String(p.title || "").slice(0, 26)}`);
}

console.log(`\n【台账：电商相关未结卡】`);
const mine = st.cards.filter((c) => ["shop", "shop_demo", "S"].includes(c.owner) && c.status !== "done" && c.status !== "cancelled");
for (const c of mine.slice(0, 12)) {
  console.log(`  #${String(c.id).padEnd(3)} ${String(c.level).padEnd(3)} ${String(c.status).padEnd(8)} ${c.owner.padEnd(9)} ${c.title.slice(0, 40)}`);
}

console.log(`\n【等你拍板】`);
const dec = st.decisions.filter((d) => d.answer == null);
if (!dec.length) console.log("  没有");
for (const d of dec) console.log(`  #${d.id} [${d.asked_by}] ${d.question}`);

console.log(`\n【最近汇报】`);
for (const r of st.reports.filter((x) => ["shop", "shop_demo", "ceo"].includes(x.agent_id)).slice(0, 4)) {
  console.log(`  [${r.agent_id}] ${String(r.summary).slice(0, 110)}`);
}

console.log(`\n【运转中的进程】`);
const jobs = ["watch-metrics", "watch-data"];
console.log(`  指标泵 logs/watch-metrics.log · 数据泵 logs/watch-data.log`);
console.log(`  手动跑一轮：node auto.mjs --no-sync`);
console.log(`  只跑分析：  node ecom-plan.mjs`);
console.log(`  只跑 CEO：  node ceo.mjs`);
console.log();
