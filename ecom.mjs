#!/usr/bin/env node
/* ecom.mjs —— 电商 Agent 的每日诊断
 *
 *   node ecom.mjs                  # 诊断 + 写汇报 + 该开卡的自动开卡
 *   node ecom.mjs --dry            # 只打印，不写库
 *   node ecom.mjs --shop shop_demo # 只看某家店
 *
 * 它读的是 orders 明细表（订单逐单数据），不是汇总数。算这些：
 *   · 今天几单 / 多少钱
 *   · 近 7 天 vs 前 7 天（环比）
 *   · 按款聚合：哪个款在扛 GMV、有没有单品依赖
 *   · 状态分布：待发货堆了几单、最久几天没发、关单率
 *   · 结论 -> 一段汇报 + 该开的卡（P0 只出决策包，不动手）
 *
 * 幂等：同名未结卡已存在就不再开。
 */

import { db, nowIso } from "./db.mjs";
import { postJSON, getJSON } from "./connectors/_http.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const arg = (n, d = null) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SHOP = arg("shop");

const day = (s) => (s ? String(s).slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const yuan = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

function rows(shop) {
  const sql = shop
    ? "SELECT * FROM orders WHERE shop = ? ORDER BY coalesce(created_at,'') DESC"
    : "SELECT * FROM orders ORDER BY coalesce(created_at,'') DESC";
  return shop ? db.prepare(sql).all(shop) : db.prepare(sql).all();
}

function summarize(list) {
  const t = today();
  const d7 = daysAgo(7), d14 = daysAgo(14);

  const inRange = (d, from, to) => d && d >= from && d < to;
  const ok = (r) => !/关闭|取消|退款/.test(r.status || "");

  const todayOrders = list.filter((r) => day(r.created_at) === t);
  const last7 = list.filter((r) => inRange(day(r.created_at), d7, t));
  const prev7 = list.filter((r) => inRange(day(r.created_at), d14, d7));

  const sum = (a) => a.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const gmvToday = sum(todayOrders.filter(ok));
  const gmv7 = sum(last7.filter(ok));
  const gmvPrev7 = sum(prev7.filter(ok));
  const wow = gmvPrev7 > 0 ? ((gmv7 - gmvPrev7) / gmvPrev7) * 100 : null;

  // 按款聚合
  const bySku = new Map();
  for (const r of last7.filter(ok)) {
    const k = (r.sku || "未知").slice(0, 40);
    const o = bySku.get(k) || { sku: k, n: 0, amt: 0 };
    o.n++; o.amt += Number(r.amount) || 0;
    bySku.set(k, o);
  }
  const skus = [...bySku.values()].sort((a, b) => b.amt - a.amt);
  const topShare = gmv7 > 0 && skus[0] ? (skus[0].amt / gmv7) * 100 : 0;

  // 状态与时效
  const pending = list.filter((r) => /待发货/.test(r.status || ""));
  const closed = list.filter((r) => /关闭|取消/.test(r.status || ""));
  const withDays = pending
    .map((r) => {
      const t = Date.parse((r.created_at || "").replace(" ", "T"));
      return { ...r, days: Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000) };
    })
    .filter((r) => r.days !== null);
  const oldestPending = withDays.sort((a, b) => b.days - a.days)[0] || null;

  return {
    totalOrders: list.length,
    todayCount: todayOrders.length, gmvToday,
    last7Count: last7.length, gmv7, gmvPrev7, wow,
    skus, topShare,
    pendingCount: pending.length, oldestPending,
    closedCount: closed.length,
    closedRate: list.length ? (closed.length / list.length) * 100 : 0,
  };
}

function diagnose(s) {
  const out = [];
  const cards = [];

  if (!s.totalOrders) {
    out.push({ level: "info", text: "还没有订单明细入库，先跑一次 node sync.mjs doudian-orders" });
    return { findings: out, cards };
  }

  // 1) 发货时效
  if (s.oldestPending && s.oldestPending.days >= 1) {
    out.push({ level: "bad", text: `有单超 ${s.oldestPending.days} 天没发（${s.pendingCount} 单待发货）` });
    cards.push({
      title: `待发货 ${s.pendingCount} 单，最久 ${s.oldestPending.days} 天 —— 今天必须发完`,
      why: `电商 Agent 诊断：待发货堆积，最久一单下单于 ${s.oldestPending.created_at}`,
      deliverable: "逐单核库存 + 打印面单 + 回填运单号",
      done_def: "所有待发货订单都变成已发货，且每单有运单号",
      level: "P1", check_day: 1,
    });
  } else if (s.pendingCount > 0) {
    out.push({ level: "warn", text: `待发货 ${s.pendingCount} 单，都在 24 小时内，正常` });
  }

  // 2) 单品依赖
  if (s.skus.length === 1) {
    out.push({ level: "warn", text: `近 7 天只有 1 个款在卖（${s.skus[0].sku.slice(0, 18)}…）—— 单品依赖` });
    cards.push({
      title: "只有 1 个款在卖，补第二个能打的款",
      why: "电商 Agent 诊断：近 7 天 GMV 全靠一个 SKU，断货/差评就归零",
      deliverable: "第二款的选品理由 + 上架计划（含定价与首图方向）",
      done_def: "第二款完成上架，且有判据（第 7 天读数口径）",
      level: "P1", check_day: 7,
    });
  } else if (s.topShare >= 80) {
    out.push({ level: "warn", text: `头部款占 GMV ${s.topShare.toFixed(0)}%，集中度偏高` });
  }

  // 3) 关单率
  if (s.closedRate >= 10) {
    out.push({ level: "bad", text: `关单/取消占 ${s.closedRate.toFixed(0)}%（${s.closedCount} 单）—— 多半是库存或发货时效问题` });
    cards.push({
      title: `关单率 ${s.closedRate.toFixed(0)}%，逐单查原因`,
      why: `电商 Agent 诊断：${s.closedCount} 单关闭/取消，占总单量 ${s.closedRate.toFixed(0)}%`,
      deliverable: "关单逐条原因归类（库存 / 超时 / 买家取消）+ 改进项",
      done_def: "每单都有一个原因标签，并给出至少 2 条可执行改进",
      level: "P1", check_day: 3,
    });
  }

  // 4) 环比
  if (s.wow !== null && s.wow <= -30) {
    out.push({ level: "bad", text: `近 7 天 GMV 环比跌 ${Math.abs(s.wow).toFixed(0)}%（${yuan(s.gmvPrev7)} -> ${yuan(s.gmv7)}）` });
    cards.push({
      title: `GMV 环比跌 ${Math.abs(s.wow).toFixed(0)}%，拆流量与转化`,
      why: `电商 Agent 诊断：前 7 天 ${yuan(s.gmvPrev7)}，近 7 天 ${yuan(s.gmv7)}`,
      deliverable: "曝光 / 点击 / 转化 三段拆分，指出掉在哪一段",
      done_def: "三段各有一个数字与对比，并给出针对该段的 3 条动作",
      level: "P0",              // 涉及要不要投流/改价，交给决策包
      check_day: 3,
    });
  }

  if (!out.length) out.push({ level: "ok", text: "没有异常：发货正常、款结构健康、没有关单堆积" });
  return { findings: out, cards };
}

async function openCardsIfNeeded(cards, shop) {
  if (DRY || !cards.length) return [];
  const st = (await getJSON(`${BASE}/api/state`)).body;
  const opened = [];
  for (const c of cards) {
    const dup = st.cards.some((x) => x.title === c.title && !["done", "cancelled"].includes(x.status));
    if (dup) { opened.push(`跳过（已有同名未结卡）：${c.title}`); continue; }
    const r = await postJSON(`${BASE}/api/cards`, { ...c, owner: shop || "shop", actor: "ecom-agent" });
    if (!r.ok) { opened.push(`开卡失败：${r.body?.error || r.error}`); continue; }
    const id = r.body?.id;
    if (c.level === "P0") {
      const d = await postJSON(`${BASE}/api/cards/${id}/request-decision`, {
        question: c.title,
        recommendation: c.deliverable,
        cost: "要动投放或价格，先看代价",
        scope: c.deliverable,
        silent_default: "不回 = 不动，维持现状。",
        asked_by: shop || "shop",
      });
      opened.push(`开卡 #${id} P0 -> 决策包 #${d.body?.decision_id}（等你批）`);
    } else {
      opened.push(`开卡 #${id} ${c.level}（等 CEO 派）`);
    }
  }
  return opened;
}

async function main() {
  const all = rows(SHOP);
  const shops = SHOP ? [SHOP] : [...new Set(all.map((r) => r.shop))];

  console.log(`\n=== 电商 Agent 诊断 · ${today()} ===`);
  console.log(`订单明细 ${all.length} 条，${shops.length} 家店\n`);
  if (!all.length) {
    console.log("还没有订单明细。先跑：node sync.mjs doudian-orders");
    return;
  }

  let totalCards = 0, totalOpened = 0;
  for (const shop of shops) {
    const list = all.filter((r) => r.shop === shop);
    if (!list.length) continue;
    const s = summarize(list);

    console.log(`-- ${shop} --`);
    console.log(`今天      ${s.todayCount} 单 / ${yuan(s.gmvToday)}`);
    console.log(`近 7 天   ${s.last7Count} 单 / ${yuan(s.gmv7)}` + (s.wow === null ? "（没有上期可比）" : `　环比 ${s.wow >= 0 ? "+" : ""}${s.wow.toFixed(0)}%`));
    console.log(`待发货    ${s.pendingCount} 单` + (s.oldestPending ? `　最久 ${s.oldestPending.days} 天` : ""));
    console.log(`关单率    ${s.closedRate.toFixed(0)}%（${s.closedCount} 单）`);
    if (s.skus.length) {
      console.log(`按款（近 7 天）：`);
      s.skus.slice(0, 5).forEach((k) => console.log(`  ${yuan(k.amt).padStart(10)}  ${String(k.n).padStart(2)} 单  ${k.sku}`));
    }

    const { findings, cards } = diagnose(s);
    console.log(`诊断：`);
    const tag = { bad: "[X]", warn: "!", ok: "[OK]", info: "·" };
    findings.forEach((f) => console.log(`  ${tag[f.level] || "·"} ${f.text}`));
    if (cards.length) {
      console.log(`该开的卡（${cards.length}）：`);
      cards.forEach((c) => console.log(`  [${c.level}] ${c.title}`));
    }
    totalCards += cards.length;

    const opened = await openCardsIfNeeded(cards, shop);
    if (opened.length) { console.log(`执行：`); opened.forEach((o) => console.log(`  ${o}`)); totalOpened += opened.filter((o) => o.startsWith("开卡")).length; }

    if (!DRY) {
      const summary =
        `今天 ${s.todayCount} 单 ${yuan(s.gmvToday)}；近 7 天 ${s.last7Count} 单 ${yuan(s.gmv7)}` +
        (s.wow === null ? "" : `（环比 ${s.wow >= 0 ? "+" : ""}${s.wow.toFixed(0)}%）`) +
        `；待发货 ${s.pendingCount} 单` + (s.oldestPending ? `、最久 ${s.oldestPending.days} 天` : "") +
        `；关单率 ${s.closedRate.toFixed(0)}%。` +
        (findings.filter((f) => f.level !== "ok").map((f) => f.text).join("；") || "无异常。");
      const r = await postJSON(`${BASE}/api/reports`, {
        agent_id: shop,
        summary,
        payload: { gmvToday: s.gmvToday, last7: s.gmv7, wow: s.wow, pending: s.pendingCount, closedRate: s.closedRate, skus: s.skus.slice(0, 5) },
      });
      console.log(`汇报已写：${r.ok ? "ok" : r.body?.error || r.error}\n`);
    } else {
      console.log(`[dry] 没写库。\n`);
    }
  }

  console.log(`本轮：异常 ${totalCards} 条需要处理，开了 ${totalOpened} 张卡${DRY ? "（dry，没真开）" : ""}。`);
}

main().catch((e) => { console.error("ecom 崩了：", e); process.exit(1); });
