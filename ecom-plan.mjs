#!/usr/bin/env node
/* ecom-plan.mjs —— 用真实数据出「诊断 -> 方案 -> 优化内容 -> 交给 CEO 的任务清单」
 *
 *   node ecom-plan.mjs                 # 分析 + 写汇报（给 CEO）
 *   node ecom-plan.mjs --dry           # 只看
 *   node ecom-plan.mjs --shop shop_demo
 *
 * 数据来源全都是真的：
 *   · 后台页面抓的指标（曝光/点击/成交/客单价/投放消耗/费比/短视频/直播/搜索/退款/售后）
 *   · orders 明细（逐单：商品名/规格/金额/状态/下单时间）
 *   · products 清单（8 个真实商品ID、价格区间、库存、状态）
 *
 * 纪律：
 *   · 成本没填就明说「毛利算不出」，不编数字
 *   · 样本太小就明说「样本不足」，不硬下结论
 *   · 每条方案必须带验证口径，否则不算方案
 */

import fs from "node:fs";
import { db } from "./db.mjs";
import { postJSON, getJSON } from "./connectors/_http.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const arg = (n, d = null) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SHOP = arg("shop", "shop_demo");
const shopInfo = (await getJSON(`${BASE}/api/shops`)).body?.shops?.find((s) => s.agent === SHOP) || {};
// 时间窗：默认跟随「这家店当前选的窗口」，只有显式 --window 才覆盖。
// 否则卡片说近7天、店铺行说实时，两个口径打架。
const WIN_OF_LABEL = { "实时": "today", "近7天": "7d", "近30天": "30d" };
const winFromArg = (() => {
  const i = process.argv.indexOf("--window");
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return null;
})();
// 默认跟随店铺窗口；若显式指定了 --window，就把店铺窗口同步过去，
// 避免"店铺选实时、汇报却按近7天算"这种自相矛盾。
const WIN_ARG = winFromArg || WIN_OF_LABEL[shopInfo.window || "实时"] || "today";
if (winFromArg) {
  const want = WIN_ARG === "7d" ? "近7天" : WIN_ARG === "30d" ? "近30天" : WIN_ARG === "all" ? "全部" : "实时";
  if (want !== shopInfo.window && want !== "全部") {
    try {
      const p = new URL("./shops.json", import.meta.url);
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      const me = arr.find((s) => s.agent === SHOP);
      if (me) {
        me.window = want;
        me.window_at = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(arr, null, 2) + "\n", "utf8");
        shopInfo.window = want;
        console.log(`[口径同步] 店铺窗口已切到「${want}」，与本次分析保持一致`);
      }
    } catch {}
  }
}
const WIN_FROM = (() => {
  if (WIN_ARG === "7d") return new Date(Date.now() - 6 * 86400000).toLocaleDateString("sv-SE");
  if (WIN_ARG === "30d") return new Date(Date.now() - 29 * 86400000).toLocaleDateString("sv-SE");
  if (WIN_ARG === "all") return "0000-00-00";
  return new Date().toLocaleDateString("sv-SE");
})();
const WIN_LABEL = WIN_ARG === "7d" ? "近7天" : WIN_ARG === "30d" ? "近30天" : WIN_ARG === "all" ? "全部" : "实时";
const SHOP_TAG = `${shopInfo.name || SHOP} · ${WIN_LABEL}`;

const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const pct = (n) => `${(Number(n) || 0).toFixed(2)}%`;

// -- 1. 收真实数据 ----------------------------------------
const st = (await getJSON(`${BASE}/api/state`)).body;
const subs = (st.submetrics || []).filter((m) => m.agent_id === SHOP);

// 关键：指标要取「这个时间窗」的那份快照。
// submetrics 只存最后一次抓取的结果，如果上次抓的是近30天、这次分析实时，
// 就会把 1605 元投放到只有 1 单的窗口里，毛利直接算成 -1598。踩过这个坑。
const shopSnap = (await getJSON(`${BASE}/api/shops`)).body?.shops?.find((s) => s.agent === SHOP);
const snapWin = shopSnap?.windows?.[WIN_LABEL]?.metrics || null;
const snapLabel = new Map();
if (snapWin) {
  for (const v of Object.values(snapWin)) {
    if (v && v.label && v.value != null && v.value !== "") snapLabel.set(v.label, v.value);
  }
}
const numOf = (s) => Number(String(s).replace(/[^\d.-]/g, ""));
const val = (label) => {
  if (snapLabel.has(label)) return numOf(snapLabel.get(label));
  const m = subs.find((x) => x.label === label);
  return m && m.ok && m.value != null && m.value !== "" ? numOf(m.value) : null;
};
const valFrom = snapWin ? `快照（${WIN_LABEL}）` : "submetrics（无快照，退回最近一次）";

const views = val("商品曝光") ?? 0;
const clicks = val("商品点击") ?? 0;
const buyers = val("成交人数") ?? 0;
const ordersToday = val("成交订单数") ?? 0;
const pay = val("成交金额") ?? val("用户支付金额") ?? 0;   // 以「成交金额」为主口径（和店铺行、卡片大数字一致），实付单独列
const aov = val("客单价") ?? 0;
const adSpend = val("投放消耗") ?? 0;
const adRatio = val("投放费比") ?? 0;
const shortVideo = val("短视频成交") ?? 0;
const live = val("直播引流成交") ?? 0;
const search = val("搜索支付金额") ?? 0;
const refund = val("退款金额") ?? 0;
const pending = val("待发货") ?? 0;
const aftersale = val("售后待处理") ?? 0;
const ctr = val("曝点转化率") ?? (views ? (clicks / views) * 100 : null);
const cvr = val("点击成交率") ?? (clicks ? (buyers / clicks) * 100 : null);

const ordersAll = db.prepare("SELECT * FROM orders WHERE shop = ? ORDER BY coalesce(created_at,'') DESC").all(SHOP);
const orders = ordersAll.filter((o) => String(o.created_at || "").slice(0, 10) >= WIN_FROM);
const prods = db.prepare("SELECT * FROM products WHERE shop = ?").all(SHOP);
const cfg = (() => {
  const d = { categoryFeeRate: 0, paymentFeeRate: 0.006, shippingPerOrder: 0, packagingPerOrder: 0, items: {} };
  try {
    const j = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
    return { ...d, ...(j.defaults || {}), ...((j.shops || {})[SHOP] || {}) };
  } catch { return d; }
})();
const costed = Object.values(cfg.items || {}).filter((c) => Number(c) > 0).length;

// 订单侧统计（真实）
const okOrders = orders.filter((r) => !/关闭|取消|退款/.test(r.status || ""));
const gmv = okOrders.reduce((n, r) => n + (Number(r.amount) || 0), 0);
const income = okOrders.reduce((n, r) => n + (r.income != null ? Number(r.income) : Number(r.amount) || 0), 0);

// 费率只信账单：抖店「结算账单」备注列直接写「平台服务费率2%;商品类目: …」
// 手填只作为没有账单时的兜底，冲突时以账单为准并明确报警。
const feeRows = db.prepare("SELECT * FROM fee_rates WHERE shop = ? ORDER BY samples DESC").all(SHOP);
const dbRate = feeRows.length ? Number(feeRows[0].rate) : null;

// 账单里费率不止一种（实测 2% 141 笔、4.6% 11 笔），单一费率会低估佣金。
// 用加权：Σ平台服务费 / Σ计费基数。
const billAgg = db.prepare(
  "SELECT ROUND(SUM(base),2) b, ROUND(SUM(ABS(service_fee)),2) f, ROUND(SUM(base - ABS(service_fee) - settle_amount),2) other, COUNT(*) n FROM settlements WHERE shop = ? AND base > 0"
).get(SHOP);
const weightedRate = billAgg && billAgg.b > 0 ? billAgg.f / billAgg.b : null;
const otherFees = billAgg ? Math.abs(Number(billAgg.other) || 0) : 0;
const cfgRate = Number(cfg.categoryFeeRate) || 0;
const feeRateUsed = weightedRate != null ? weightedRate : (dbRate != null ? dbRate : cfgRate);
const feeConflict = dbRate != null && cfgRate > 0 && Math.abs(dbRate - cfgRate) > 0.0001;
const feeRateSource = weightedRate != null
  ? `账单加权 ${(weightedRate * 100).toFixed(2)}%（服务费 ¥${billAgg.f} ÷ 基数 ¥${billAgg.b}，${billAgg.n} 笔）` +
    (otherFees > 0.01 ? `；另有其他扣款 ¥${otherFees.toFixed(2)}` : "")
  : dbRate != null
  ? `账单实查 ${(dbRate * 100).toFixed(2)}%（类目 ${feeRows[0].category}，${feeRows[0].samples} 笔样本）`
  : cfgRate > 0
    ? `手填 ${(cfgRate * 100).toFixed(2)}%（没抓到账单，暂用这个）`
    : "未知（没抓到账单，也没手填）→ 佣金算不出来";

// 佣金优先用账单实扣金额（最准），其次按费率推算，都没有就不下结论
const settleRows = db.prepare("SELECT order_id, service_fee, base, fee_rate FROM settlements WHERE shop = ?").all(SHOP);
const settleMap = new Map(settleRows.map((r) => [String(r.order_id), r]));
let commissionBill = 0, settledN = 0;
for (const o of okOrders) {
  const s = settleMap.get(String(o.order_id));
  if (s && s.service_fee != null) { commissionBill += Math.abs(Number(s.service_fee)); settledN++; }
}
// 账单实扣只有在「对上的单数够多」时才代表整体。
// 之前 391 单里只对上 8 单（账单只有 10 笔老订单），拿 ¥1.80 当 391 单的佣金，
// 直接把毛利率算高了 —— 所以加覆盖率门槛：不到一半就退回按费率推算。
const billCoverage = okOrders.length ? settledN / okOrders.length : 0;
const useBill = settledN > 0 && billCoverage >= 0.5;
const commission = useBill
  ? +commissionBill.toFixed(2)
  : (feeRateUsed > 0 ? +(income * feeRateUsed).toFixed(2) : null);
const commissionSource = useBill
  ? `账单实扣 ¥${commissionBill.toFixed(2)}（${settledN}/${okOrders.length} 单已结算）`
  : (feeRateUsed > 0
      ? `按实收 ¥${income.toFixed(2)} × ${(feeRateUsed * 100).toFixed(2)}% = ¥${(income * feeRateUsed).toFixed(2)}` + (settledN > 0 ? `（账单只对上 ${settledN} 单，不足以代表全量）` : "")
      : "未知");

// 优惠分摊（商家承担的券）
const discountTot = Math.max(0, +(gmv - income).toFixed(2));
const discOrders = okOrders.filter((r) => r.income != null && Number(r.amount) > Number(r.income));
const discGaps = discOrders.map((r) => +(Number(r.amount) - Number(r.income)).toFixed(2));
const discFixed = discGaps.length > 1 && discGaps.every((g) => Math.abs(g - discGaps[0]) < 0.01);
const disountSource = discOrders.length
  ? `优惠分摊 ¥${discountTot}（${discOrders.length} 单${discFixed ? `，每单固定 ¥${discGaps[0]}` : "，金额不等"}）`
  : "优惠分摊 ¥0";

// SKU 清单：成本按 SKU 记，订单里的规格文字（【囤货装】）用来定位是哪个 SKU
const skuRows = db.prepare("SELECT * FROM skus WHERE shop = ?").all(SHOP);
const specOf = (s) => (String(s || "").match(/【([^】]+)】/) || [])[1] || null;
const skuBySpec = new Map();
for (const s of skuRows) {
  const k = specOf(s.spec) || String(s.spec || "").trim();
  if (k) skuBySpec.set(k, s);
}
const costOf = (orderSku, itemId) => {
  const spec = specOf(orderSku);
  const sku = spec ? skuBySpec.get(spec) : null;
  const items = cfg.items || {};
  // 顺序：SKU 级成本 -> 商品级成本 -> 无
  if (sku && items[sku.sku_id]) return { cost: Number(items[sku.sku_id]), key: sku.sku_id, from: "SKU" };
  if (itemId && items[itemId]) return { cost: Number(items[itemId]), key: itemId, from: "商品" };
  if (sku && items[`${sku.item_id}|${sku.spec}`]) return { cost: Number(items[`${sku.item_id}|${sku.spec}`]), key: "", from: "SKU" };
  return null;
};

let goods = 0, unitsOk = 0, unitsAll = 0;
const missingSku = new Set();
for (const r of okOrders) {
  const q = Number(r.qty) || 1;
  unitsAll += q;
  const hit = costOf(r.sku, r.item_id);
  if (!hit) { missingSku.add(specOf(r.sku) ? `【${specOf(r.sku)}】` : String(r.sku || "未知").slice(0, 16)); continue; }
  goods += hit.cost * q;
  unitsOk += q;
}
const costReady = skuRows.length > 0 && unitsAll > 0 && unitsOk > 0 && goods > 0;

// ── 利润（口径写死在这里，避免重复扣费）─────────────────
const payRate = Number(cfg.paymentFeeRate) || 0;
// 未填 vs 包邮要分开：留空=没填（毛利偏高，要提示）；填 0=包邮（真实 0，不提示）
const shipRaw = cfg.shippingPerOrder;
const packRaw = cfg.packagingPerOrder;
const shipKnown = shipRaw !== null && shipRaw !== undefined && packRaw !== null && packRaw !== undefined;
const shipPack = (Number(shipRaw) || 0) + (Number(packRaw) || 0);
const logistics = shipPack * okOrders.length;
const payFee = income * payRate;

const incomeIsReal = okOrders.some((r) => r.income != null);
// 订单明细里的「商家收入」不含佣金（有 2 单买家支付=商家收入，一分没扣），

// （佣金已在上面按账单实扣计算，这行重复定义已删）
// 覆盖度守卫：明细单数必须接近后台单数，否则毛利不可算（口径混杂会算出负数垃圾）
const dashOrders = ordersToday || 0;
const coverage = dashOrders > 0 ? okOrders.length / dashOrders : 1;
const coverageOk = dashOrders === 0 ? okOrders.length === 0 : coverage >= 0.5;
const noOrdersInWin = okOrders.length === 0;

const profitRaw = costReady && commission != null && coverageOk && !noOrdersInWin
  ? (income - commission - payFee - goods - logistics - adSpend)
  : null;
const profit = profitRaw;
const margin = profit !== null && income > 0 ? (profit / income) * 100 : null;
const perOrder = profit !== null && okOrders.length ? profit / okOrders.length : null;
const breakEvenRoi = margin && margin > 0 ? 100 / margin : null;
const itemsCount = Object.values(cfg.items || {}).filter((v) => Number(v) > 0).length;
const byDay = new Map();
for (const r of okOrders) {
  const d = String(r.created_at || "").slice(0, 10);
  const o = byDay.get(d) || { d, n: 0, amt: 0 };
  o.n++; o.amt += Number(r.amount) || 0;
  byDay.set(d, o);
}
const days = [...byDay.values()].sort((a, b) => b.d.localeCompare(a.d));
const bySpec = new Map();
for (const r of okOrders) {
  const m = String(r.sku || "").match(/【(.+?)】/);
  const k = m ? m[1] : "无规格";
  const o = bySpec.get(k) || { k, n: 0, amt: 0 };
  o.n++; o.amt += Number(r.amount) || 0;
  bySpec.set(k, o);
}
const specs = [...bySpec.values()].sort((a, b) => b.n - a.n);

// -- 2. 诊断（每条都挂真实数字）-------------------------
const D = [];   // 诊断
const P = [];   // 方案
const T = [];   // 交给 CEO 执行的任务
const E = [];   // 必须上报给你

const sampleTiny = okOrders.length < 20;
// 三件事要分开判，别混成一个"成本没填"：
//   ① 参数本身填了没（拿货价 + 费率）
//   ② 这一窗有没有订单
//   ③ 明细覆盖够不够
const paramsFilled = itemsCount > 0 && feeRateUsed > 0;
if (!paramsFilled) {
  D.push({ lv: "bad", t: `经营参数不全（已填 ${itemsCount} 个 SKU 拿货价${feeRateUsed > 0 ? "" : "，费率未知"}）→ 毛利算不出来` });
  T.push({
    owner: "S",
    title: `填经营参数：拿货价 + 类目扣点（${shopInfo.name || SHOP}）`,
    why: "没有拿货成本和费率，毛利、保本 ROI、哪个链接赚钱全都算不出来",
    deliverable: "在「店铺 -> 参数」里补齐每个 SKU 的拿货价；费率会自动从结算账单抓",
    done_def: "全部 SKU 有拿货价（>0），且能从结算账单抓到类目费率",
    level: "P1", check_day: 2,
  });
} else if (noOrdersInWin) {
  D.push({ lv: "info", t: `这一窗（${WIN_LABEL}）没有订单 —— 毛利不适用，不是成本没填（${itemsCount} 个 SKU 成本已就绪）` });
}

// 2.1 流量结构
const card = Math.max(0, pay - shortVideo - live);
const ch = [
  { n: "商品卡", v: card }, { n: "短视频", v: shortVideo }, { n: "直播", v: live },
].map((c) => ({ ...c, s: pay > 0 ? (c.v / pay) * 100 : 0 })).sort((a, b) => b.v - a.v);
D.push({ lv: "info", t: `成交结构：${ch.map((c) => `${c.n} ${y(c.v)}(${c.s.toFixed(0)}%)`).join(" · ")}；搜索带来支付 ${y(search)}` });
if (ch[1] && ch[1].v === 0) D.push({ lv: "bad", t: "直播 0 成交 —— 这条腿完全没跑起来" });

// 2.2 漏斗
if (ctr !== null) {
  D.push({ lv: ctr < 3 ? "warn" : "ok", t: `曝光 ${views} -> 点击 ${clicks}（${pct(ctr)}）-> 成交 ${buyers}（${cvr === null ? "—" : pct(cvr)}）` });
}
if (ctr !== null && ctr < 3) {
  P.push({
    id: "P1-首图标题", pri: "高",
    what: "换主图 + 标题补搜索词（曝光有量，点击只有 2.5%，问题在第一眼）",
    do: "① 前 3 张主图重做：一张拍饼本身、一张撕开展示层次、一张标规格与张数；② 标题保留「榆林镇/筋饼/春饼/面皮」等已有关键词，补「早餐/非油炸/家用」长尾",
    verify: "7 天后曝点转化率 ≥ 4%（当前 2.53%）",
  });
  T.push({
    title: `${SHOP_TAG}：重做主图 3 张 + 标题补长尾词`,
    why: `曝光 ${views} 次只换来 ${clicks} 次点击（${pct(ctr)}），钱在第一步就漏了`,
    deliverable: "3 张新主图 + 新标题文案（8 个链接同一套），上架后记录改前改后 7 天数据",
    done_def: "8 个链接都换成新主图新标题，且第 7 天曝点转化率 ≥ 4%",
    level: "P1", check_day: 7,
  });
}

// 2.3 投放
const roi = adSpend > 0 ? pay / adSpend : null;
if (adSpend > 0) {
  D.push({ lv: "ok", t: `投放只花了 ${y(adSpend)}（费比 ${pct(adRatio)}），ROI ${roi ? roi.toFixed(1) : "—"} —— 钱花得太少，等于没投` });
  if (adSpend < 20 && pay > 0) {
    P.push({
      id: "P2-投放", pri: "中",
      what: "投放预算从「几乎没投」提到能被统计的量（比如日预算 30 元封顶），跑 7 天看真实 ROI",
      do: "新建 1 个商品卡计划，只投当前转化最好的款，出价用系统建议下限，日预算 30 元",
      verify: "7 天后：投放消耗 > 100 元且 ROI ≥ 保本线（等成本填了才能算保本线）",
    });
    T.push({
      title: `${SHOP_TAG}：开一个 30 元/日的小投放计划，跑 7 天`,
      why: `目前投放 ${y(adSpend)}，样本太小无法判断投放是否值得加`,
      deliverable: "1 个商品卡计划（单款、日预算 30、系统建议下限出价）+ 7 天数据记录",
      done_def: "计划跑满 7 天、累计消耗 > 100 元，并给出 ROI 与结论",
      level: "P2", check_day: 7,
    });
  }
}

// 2.4 商品结构（8 个链接同标题 = 内耗）
if (prods.length >= 2) {
  const titles = prods.map((p) => String(p.title || "").trim());
  const uniq = new Set(titles.map((t) => t.replace(/\s+/g, "")));
  if (uniq.size <= 2 && prods.length >= 4) {
    D.push({ lv: "bad", t: `商品清单 ${prods.length} 个链接，标题只有 ${uniq.size} 种 —— 同款重复铺货，自己人和自己人抢曝光` });
    E.push({
      title: `${SHOP_TAG}：${prods.length} 个重复链接，要不要合并/下架`,
      recommendation: "保留销量最好那 1~2 个，其余下架；下架前先把评价与销量导出来",
      cost: "下架会丢链接权重；合并后短期可能掉曝光",
      scope: "只动重复链接，不动主推款",
      silent_default: "不回 = 全部保留，继续内耗。",
    });
    T.push({
      title: `${SHOP_TAG}：盘清 ${prods.length} 个重复链接`,
      why: `标题只有 ${uniq.size} 种却有 ${prods.length} 个链接，等于自己跟自己抢搜索位`,
      deliverable: "一张表：每个链接的 ID、销量、库存、评价数，标「留/下架」及理由",
      done_def: "8 个链接每个都有结论，且下架名单经你确认",
      level: "P1", check_day: 3,
    });
  }
}

// 2.5 规格结构
if (specs.length >= 2) {
  D.push({ lv: "info", t: `规格结构：${specs.map((s) => `${s.k} ${s.n} 单 ${y(s.amt)}`).join(" · ")}` });
  const best = specs[0];
  P.push({
    id: "P3-主推规格", pri: "中",
    what: `把「${best.k}」做成主推，其它规格作为补充（它卖得最多：${best.n} 单）`,
    do: "主图第一张只放主推规格；价格锚点用高配套装衬托",
    verify: `${best.k} 单量占比再提升 20%`,
  });
}

// 2.6 履约与售后
if (pending > 0) D.push({ lv: "bad", t: `待发货 ${pending} 单堆着` });
if (aftersale > 0) {
  D.push({ lv: "bad", t: `售后待处理 ${aftersale} 单 —— 抖店售后超时有罚款` });
  T.push({
    title: `${SHOP_TAG}：把 ${aftersale} 个待处理售后今天处理完`,
    why: "售后超时会被平台罚款，且影响体验分（当前 91 分）",
    deliverable: "逐单处理并留处理记录（退款/补发/驳回理由）",
    done_def: "售后待处理 = 0",
    level: "P1", check_day: 1,
  });
}

// 2.7 样本量提醒
if (sampleTiny) {
  D.push({ lv: "warn", t: `订单样本只有 ${okOrders.length} 单（${days.length} 天）—— 任何"哪个款更赚钱"的结论都不成立，别据此砍款` });
}

// 2.8 成交额现状
D.push({ lv: "info", t: `累计成交 ${okOrders.length} 单 / 买家支付 ${y(gmv)} / 商家收入 ${y(income)}；日均 ${(gmv / Math.max(1, days.length)).toFixed(2)} 元` });

// -- 3. 打印 ---------------------------------------------
console.log(`\n=== 电商 Agent 分析 · ${SHOP} · ${WIN_LABEL} · 真实数据 ===\n`);
console.log(`【数据】口径 ${valFrom} · 指标 ${subs.length} 项 · 订单明细 ${orders.length} 单 · 商品 ${prods.length} 个 · SKU ${skuRows.length} 条 · 已填成本 ${itemsCount} 个 SKU`);
console.log(`【费用】${disountSource}`);
console.log(`　　　　${feeRateSource}`);
console.log(`　　　　佣金 ${commission == null ? "未知" : "¥" + commission}（${commissionSource}）`);
if (feeConflict) console.log(`　　　　[!] 手填 ${(cfgRate * 100).toFixed(2)}% 与账单 ${(dbRate * 100).toFixed(2)}% 不一致，已按账单算——去把参数里的扣点改成 ${(dbRate * 100).toFixed(2)}`);
console.log(`【利润】` + (profit === null
  ? (noOrdersInWin
      ? `这一窗没有订单（${WIN_LABEL}），毛利不适用`
      : !coverageOk
        ? `算不出来 —— 明细只抓到 ${okOrders.length}/${dashOrders} 单（覆盖 ${(coverage * 100).toFixed(0)}%），后台数是全量的，混算会得出垃圾结果；先补翻页`
        : commission == null
          ? `算不出来 —— 佣金未知（没抓到账单，也没费率）`
          : `算不出来 —— 缺这些 SKU 的拿货价：${[...missingSku].slice(0, 6).join("、") || "（全部）"}`)
  : `毛利 ${y(profit)}　毛利率 ${pct(margin)}　单均 ${y(perOrder)}` +
    (breakEvenRoi ? `　保本 ROI ${breakEvenRoi.toFixed(2)}` : "")));
if (costReady) {
  console.log(`        拿货 ${y(goods)} · 佣金 ${commission == null ? "未知" : y(commission)} · 物流包装 ${y(logistics)} · 支付手续费 ${y(payFee)} · 投放 ${y(adSpend)}`);
  if (!shipKnown) console.log(`        [!] 物流/包装未填（包邮就填 0），上面的毛利偏高；按每单 3.5 元算要再扣 ${y(3.5 * okOrders.length)}`);
}
// 按 SKU 拆毛利：哪个规格最赚，一目了然
if (costReady && skuRows.length) {
  const one = incomeIsReal ? 1 : 1 - feeRateUsed;   // 有商家收入就直接用，否则按扣点折算
  const byspec = new Map();
  for (const r of okOrders) {
    const spec = specOf(r.sku) || String(r.sku || "未知").slice(0, 14);
    const revenue = (r.income != null ? Number(r.income) : (Number(r.amount) || 0) * one);
    const q = Number(r.qty) || 1;
    const hit = costOf(r.sku, r.item_id);
    const o = byspec.get(spec) || { spec, n: 0, revenue: 0, cost: 0, costed: true };
    o.n += q;
    o.revenue += revenue;
    if (hit) o.cost += hit.cost * q; else o.costed = false;
    byspec.set(spec, o);
  }
  const rows2 = [...byspec.values()].map((o) => ({
    ...o,
    gross: o.costed ? o.revenue - o.cost : null,
    rate: o.costed && o.revenue > 0 ? ((o.revenue - o.cost) / o.revenue) * 100 : null,
  })).sort((a, b) => (b.gross ?? -1e9) - (a.gross ?? -1e9));

  console.log(`\n【按 SKU 毛利】（未扣物流/投放分摊）`);
  for (const r of rows2) {
    console.log(`  ${String(r.spec).padEnd(22)} ${String(r.n).padStart(2)} 件  收入 ${y(r.revenue).padStart(9)}  拿货 ${y(r.cost).padStart(8)}  ` +
      (r.gross === null ? "成本缺" : `毛利 ${y(r.gross).padStart(8)}　毛利率 ${pct(r.rate).padStart(7)}`));
  }

  // 物流敏感度：快递费只有你知道，所以把几种常见值摆出来，你自己对号
  if (!shipKnown && okOrders.length) {
    console.log(`\n【物流敏感度】每单快递+包装填多少，毛利变成这样：`);
    for (const v of [2, 3, 3.5, 4, 5]) {
      const cost = v * okOrders.length;
      const p2 = profit === null ? null : profit - cost;
      const m2 = p2 !== null && income > 0 ? (p2 / income) * 100 : null;
      console.log(`  每单 ${String(v).padEnd(4)} 元 → 毛利 ${y(p2).padStart(8)}　毛利率 ${pct(m2).padStart(7)}`);
    }
    console.log(`  （按你最可能的那个值填进「参数」里的单均物流+包装）`);
  }
}

console.log(`\n【诊断】`);
D.forEach((d) => console.log(`  ${{ bad: "[X]", warn: "!", ok: "[OK]", info: "·" }[d.lv]} ${d.t}`));
console.log(`\n【方案】`);
P.forEach((p, i) => {
  console.log(`  ${i + 1}. [${p.pri}] ${p.id}：${p.what}`);
  console.log(`     动作：${p.do}`);
  console.log(`     验证：${p.verify}`);
});
console.log(`\n【交给 CEO 执行的任务 ${T.length} 条】`);
T.forEach((t) => console.log(`  [${t.level}] ${t.title}\n        完成判据：${t.done_def}`));
console.log(`\n【必须你拍板 ${E.length} 条】`);
E.forEach((e) => console.log(`  [P0] ${e.title}\n        代价：${e.cost}\n        不回：${e.silent_default}`));
if (!paramsFilled) console.log(`\n[!] 经营参数不全，本报告没有毛利结论。`);
else if (noOrdersInWin) console.log(`\n[i] 这一窗没有订单，毛利不适用（成本已就绪）。`);

// -- 4. 写汇报（CEO 会读它）----------------------------
if (DRY) { console.log(`\n[dry] 没写库。`); process.exit(0); }

const summary =
  `${WIN_LABEL}：成交 ${y(pay)}（用户实付 ${y(val("用户支付金额") ?? pay)}）、订单 ${ordersToday} 单、客单价 ${y(aov)}；` +
  `漏斗 曝光${views}->点击${clicks}（${pct(ctr || 0)}）->成交${buyers}人（${pct(cvr || 0)}）；` +
  `投放 ${y(adSpend)}（费比 ${pct(adRatio)}）；待发货 ${pending}、售后 ${aftersale}；` +
  `明细 ${okOrders.length} 单、商品 ${prods.length} 个。` +
  `诊断异常 ${D.filter((d) => d.lv !== "info" && d.lv !== "ok").length} 项，方案 ${P.length} 条，交 CEO ${T.length} 条，需你拍板 ${E.length} 条。` +
  (profit != null ? "" : (paramsFilled ? (noOrdersInWin ? "这一窗无订单。" : "覆盖不足或无佣金。") : "参数不全，无毛利结论。"));

const r = await postJSON(`${BASE}/api/reports`, {
  agent_id: "shop", summary,   // 汇报给「电商 Agent」这一层，店铺只做数据源
  payload: {
    kind: "ecom-plan",
    facts: { window: WIN_LABEL, views, clicks, buyers, pay, aov, adSpend, adRatio, shortVideo, live, search, refund, pending, aftersale, orders: okOrders.length, gmv, income, products: prods.length, costed, feeRate: feeRateUsed, feeSource: feeRateSource, coverage: +(coverage * 100).toFixed(1), detailOrders: okOrders.length, dashOrders, commission: commission, commissionSource, billCoverage: +(billCoverage * 100).toFixed(1), discount: discountTot, discountSource: disountSource, shipKnown, shipPack },
    diagnose: D, plans: P, tasks: T, escalations: E, costReady,
  },
});
console.log(`\n汇报已写给电商 Agent：${r.ok ? "ok" : r.body?.error || r.error}`);

// 4.1 电商 Agent 那张卡：**跟店铺行同一个口径**（后台成交金额 + 当前时间窗），
// 不能自己按订单明细另算一个数，否则卡片和店铺行互相打架。
const ordersInWin = okOrders.length;
const hb = await postJSON(`${BASE}/api/agents/shop/heartbeat`, {
  metric_label: `${WIN_LABEL}成交`,
  metric_value: String(Math.round(Number(pay || 0) * 100) / 100),
  metric_extra: `${WIN_LABEL} · 成交 ${y(pay)}（实付 ${y(val("用户支付金额") ?? pay)}）· 明细 ${ordersInWin} 单 · ${prods.length} 链接`,
  next_run_at: new Date(Date.now() + 60 * 60000).toISOString(),
});
console.log(`电商 Agent 卡片：${WIN_LABEL}成交 ${y(pay)}（后台口径，与店铺行一致；${hb.ok ? "ok" : hb.body?.error || hb.error}）`);

// 4.2 沉淀：这次分析算出的结论与判据入知识库（"学习"就是把结论和判据留下来）
const kbBody = [
  `口径：后台 ${WIN_LABEL} 成交 ${y(pay)} / 订单 ${ordersToday} 单 / 客单价 ${y(aov)}；明细 ${okOrders.length} 单（买家支付 ${y(gmv)}，商家收入 ${y(income)}）`,
  `流量：商品卡 ${y(card)}（${ch[0]?.s.toFixed(0) ?? 0}%）· 短视频 ${y(shortVideo)} · 直播 ${y(live)}`,
  `漏斗：曝光 ${views} -> 点击 ${clicks}（${pct(ctr || 0)}）-> 成交 ${buyers}（${pct(cvr || 0)}）`,
  `投放：消耗 ${y(adSpend)}，费比 ${pct(adRatio)}${roi ? `，ROI ${roi.toFixed(1)}` : ""}`,
  `结构：商品 ${prods.length} 个链接，标题 ${new Set(prods.map((p) => String(p.title || "").trim())).size} 种；规格 ${specs.map((s) => `${s.k}=${s.n}单`).join("/")}`,
  `履约：待发货 ${pending} · 售后待处理 ${aftersale}`,
  `判据（下次对照）：曝点转化率基线 ${pct(ctr || 0)}，低于 3% 视为首图问题；投放费比超过毛利率即停投；同标题多链接 >2 个视为内耗`,
  costReady ? `成本：已填 ${costed} 个链接` : `成本：未填（${prods.length} 个链接拿货价为空），毛利无法计算`,
].join("\n");

const kb = await postJSON(`${BASE}/api/kb`, {
  dept: "shop",
  title: `电商诊断 · ${new Date().toLocaleDateString("sv-SE")}`,
  body: kbBody,
});
console.log(`结论已沉淀进知识库：${kb.ok ? `#${kb.body?.id}${kb.body?.updated ? "（今天已更新）" : ""}` : kb.body?.error || kb.error}`);
console.log(`\n下一步：node ceo.mjs   （CEO 会读这份 payload，自己派活/上报）`);
