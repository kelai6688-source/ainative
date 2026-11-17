#!/usr/bin/env node
/* ceo.mjs —— CEO Agent 的一轮工作：收汇报 -> 分析 -> 派活 / 上报
 *
 *   node ceo.mjs            # 干活（开卡 / 出决策包 / 写汇报）
 *   node ceo.mjs --dry      # 只分析不写库
 *
 * 它干的事（严格按顺序）：
 *   1. 收：把每个 Agent 今天的数据、汇报、未结卡收上来
 *   2. 判：三种判断
 *        · 没数据源的 -> 派活「先接一条数据源」（P1）
 *        · 数据源挂了   -> 派活「修数据源」（P1）
 *        · 该看却没说   -> 派活「今天先报一次」（P2）
 *   3. 上报：只有这几类才惊动我，并且做成决策包（P0）
 *        · 要花钱（投流/进货/上新品）
 *        · 要动价格 / 停售 / 改方向
 *        · 指标断崖（GMV 环比跌 ≥30%、退款率 ≥20%）
 *   4. 写：一份 CEO 日报（谁有数、谁没数、今天派了什么、哪件事等我）
 *
 * 说明：这里是**规则判断**，不是大模型推理。规则写在代码里，改一行就能改判断。
 * 想要模型参与，在 `analyze()` 里加一层调用即可，其余不变。
 */

import { postJSON, getJSON } from "./connectors/_http.mjs";
import { db } from "./db.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const DRY = process.argv.includes("--dry");
const today = () => new Date().toLocaleDateString("sv-SE");   // YYYY-MM-DD 本地
const yuan = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

const st = await getJSON(`${BASE}/api/state`).then((r) => r.body);
if (!st) { console.error(`连不上 ${BASE}，先 node server.mjs`); process.exit(1); }

const cardsOpen = (agent) => st.cards.filter((c) => c.owner === agent && !["done", "cancelled"].includes(c.status));
const hasReportToday = (agent) => st.reports.some((r) => r.agent_id === agent && String(r.created_at || "").slice(0, 10) === today());

// -- 1. 收：每家的数据源状态 --------------------------------
const conns = await getJSON(`${BASE}/api/connectors`).then((r) => r.body?.connectors || []);
const shops = await getJSON(`${BASE}/api/shops`).then((r) => r.body?.shops || []);
const shopAgents = new Set(shops.map((s) => s.agent));

// 店铺不是平级 Agent —— 它们挂在「电商」名下。CEO 只看业务层，店铺状态汇总进电商。
const stores = st.agents.filter((a) => shopAgents.has(a.id)).map((a) => {
  const s = shops.find((x) => x.agent === a.id) || {};
  return { id: a.id, name: s.name || a.name, alive: !!a.alive, metric: a.metric_value || "—", label: a.metric_label || "" };
});
const storesOk = stores.filter((s) => s.alive).length;

const biz = st.agents.filter((a) => !["S", "ceo"].includes(a.id) && !shopAgents.has(a.id));
const rows = biz.map((a) => {
  const mine = conns.filter((c) => c.agent === a.id);
  const active = mine.filter((c) => c.enabled);
  const subs = (st.submetrics || []).filter((m) => m.agent_id === a.id);
  const failed = subs.filter((m) => !m.ok);
  // 电商的「数据源」= 它名下的店
  const isShopOwner = a.id === "shop";
  const hasSource = active.length > 0 || (isShopOwner && stores.length > 0);
  const latestSub = subs.slice().sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
  // 汇报：电商看它名下店铺今天有没有 ecom 汇报
  const reported = isShopOwner
    ? st.reports.some((r) => shopAgents.has(r.agent_id) && String(r.created_at || "").slice(0, 10) === today())
    : hasReportToday(a.id);
  return {
    agent: a,
    hasSource,
    activeCount: active.length + (isShopOwner ? stores.length : 0),
    failedCount: failed.length + (isShopOwner ? stores.length - storesOk : 0),
    alive: isShopOwner ? storesOk > 0 : !!a.alive,
    metric: isShopOwner ? `${storesOk}/${stores.length} 店在跑` : a.metric_value || "—",
    metricLabel: isShopOwner ? "店铺" : a.metric_label || "",
    subs,
    latestSub,
    openCards: cardsOpen(a.id).length,
    reported,
    dataStale: latestSub ? (Date.now() - Date.parse(latestSub.at)) > 6 * 3600 * 1000 : true,
  };
});

// -- 2. 判：该派什么活 ------------------------------------
const plan = [];   // { kind:"card"|"decision", ... }
const notes = [];

for (const r of rows) {
  const a = r.agent;

  // 2.1 没数据源 —— 这家 Agent 现在是瞎的
  if (!r.hasSource) {
    plan.push({
      kind: "card", owner: a.id, level: "P1", title: `${a.name}：先接一条数据源`,
      why: `CEO 判断：${a.name} 现在没有任何已启用的数据源，它报不了数也做不了判断`,
      deliverable: "选一条能拿到的数据源（后台导出 CSV / 页面抓取 / 开放平台 API），接上并「试连」成功",
      done_def: `${a.name} 的灯变绿，且至少有一个指标在滚动更新`,
      check_day: 3,
    });
    continue;
  }

  // 2.2 数据源挂了
  if (!r.alive || r.failedCount > 0) {
    plan.push({
      kind: "card", owner: a.id, level: "P1", title: `${a.name}：数据源失败，先修数据`,
      why: `CEO 判断：${r.failedCount || 1} 个数据源取数失败${r.latestSub ? `（${r.latestSub.extra || "原因见日志"}）` : ""}`,
      deliverable: "定位失败原因（会话过期 / 选择器变了 / 频控），修好并试连成功",
      done_def: "该店灯变绿，且指标时间戳在 1 小时内",
      check_day: 1,
    });
  }

  // 2.3 催汇报：合并成一张卡，不要每个 Agent 都开一张（那叫刷屏，不叫管理）
}

const silent = rows.filter((r) => r.hasSource && r.alive && !r.reported).map((r) => r.agent.name);
if (silent.length) {
  plan.push({
    kind: "card", owner: "ceo", level: "P2",
    title: `${silent.length} 个 Agent 今天没汇报`,
    why: `CEO 判断：${silent.join("、")} 今天还没有汇报，我不知道它们在干什么`,
    deliverable: "逐个催一次，拿到一句话汇报（做了什么 / 卡在哪 / 明天做什么）",
    done_def: `汇报流里出现这 ${silent.length} 家的今日条目`,
    check_day: 1,
  });
}

// 2.4 自愈：店铺已删 / 数据源已恢复 的旧卡，CEO 自己撤掉
//     否则台账一直挂着「先修数据」，人分不清哪些是真的。
const shopNames = new Set(shops.map((s) => s.name || s.agent));
const autoCancel = [];
for (const c of st.cards) {
  if (["done", "cancelled"].includes(c.status)) continue;
  const t = String(c.title || "");
  const m = t.match(/（([^）]+)）\s*$/);
  if (m && !shopNames.has(m[1]) && /填经营参数|盘清|重做主图|投放计划|售后/.test(t)) {
    autoCancel.push({ id: c.id, why: `店铺「${m[1]}」已删除，这条不再有效` });
    continue;
  }
  if (/数据源失败|先修数据|数据源挂了/.test(t)) {
    const ownerRows = rows.filter((r) => r.agent.id === c.owner);
    if (ownerRows.some((r) => r.alive && r.failedCount === 0)) {
      autoCancel.push({ id: c.id, why: "数据源已恢复（最近一轮抓取成功），这条可以撤" });
    }
  }

  // 经营参数已填全，还挂着「填经营参数」-> 结掉
  if (/填经营参数/.test(t)) {
    const ready = (shops || []).find((s) => s.params_ready
      && (!m || String(s.name || "").includes(m[1]) || m[1].includes(String(s.name || "").slice(0, 6))));
    if (ready) autoCancel.push({ id: c.id, why: `${ready.name || ready.agent} 的经营参数已填全（拿货价 + 扣点），这条完成` });
  }
}

// 2.5 上报闸门：只有这几类惊动我（P0 决策包）
// 先看电商 Agent 有没有交上来「分析型汇报」（ecom-plan 产出的 payload.tasks / escalations）
const planReport = (() => {
  const list = st.reports.filter((r) => shopAgents.has(r.agent_id) || r.agent_id === "shop");
  for (const r of list) {
    try {
      const p = JSON.parse(r.payload_json || "{}");
      if (p && p.kind === "ecom-plan") return { agent: r.agent_id, p };
    } catch {}
  }
  return null;
})();

if (planReport) {
  const { agent, p } = planReport;
  // 电商 Agent 交上来的可执行任务 -> CEO 直接派活
  for (const t of p.tasks || []) {
    plan.push({
      kind: "card", owner: t.owner || agent, level: t.level || "P1", title: t.title,
      why: t.why || "电商 Agent 分析结论",
      deliverable: t.deliverable, done_def: t.done_def, check_day: t.check_day || 3,
    });
  }
  // 电商 Agent 判断「自己办不了」的 -> CEO 原样上报
  for (const e of p.escalations || []) {
    plan.push({
      kind: "decision", level: "P0", title: e.title,
      recommendation: e.recommendation, cost: e.cost, scope: e.scope, silent_default: e.silent_default,
    });
  }
  notes.push(`读过电商 Agent 的分析：${(p.tasks || []).length} 条任务、${(p.escalations || []).length} 条上报`);
}

const ecomReports = st.reports.filter((r) => r.agent_id === "shop_demo" || r.agent_id === "shop");
const ecomPayload = (() => {
  for (const r of ecomReports) {
    try { const p = JSON.parse(r.payload_json || "{}"); if (p && (p.wow !== undefined || p.closedRate !== undefined)) return p; } catch {}
  }
  return null;
})();

if (ecomPayload) {
  if (ecomPayload.wow !== null && ecomPayload.wow !== undefined && ecomPayload.wow <= -30) {
    plan.push({
      kind: "decision", level: "P0",
      title: `电商 GMV 环比跌 ${Math.abs(ecomPayload.wow).toFixed(0)}%，要不要动投放/价格`,
      recommendation: "先不动价格；把钱压到还在转化的款，观察 3 天",
      cost: `近 7 天 ${yuan(ecomPayload.last7)}，若下跌持续一周约少 ${yuan(Math.abs(ecomPayload.last7 * (ecomPayload.wow / 100)))}`,
      scope: "只动 1 个款的价格与 1 个投放计划，不碰其它",
      silent_default: "不回 = 不动价格、不动投放。",
    });
  }
  if (ecomPayload.closedRate >= 20) {
    plan.push({
      kind: "decision", level: "P0",
      title: `关单率 ${ecomPayload.closedRate.toFixed(0)}%，要不要暂停受影响款`,
      recommendation: "先查库存与发货时效，暂停 1 个款 24 小时看关单是否归零",
      cost: "暂停期间该款零成交；不暂停则继续掉权",
      scope: "只暂停 1 个款，不改价不删链接",
      silent_default: "不回 = 不暂停，继续卖。",
    });
  }
}

// -- 3. 派活 / 上报（幂等） --------------------------------
const done = [];
// 去重看「事情本身」：把「店铺 · 时间窗：」这个前缀剥掉再比，
// 否则换个窗口（实时/近7天/近30天）就会为同一件事重复开卡。
const topicOf = (t) => String(t || "")
  .replace(/^【上报】/, "")
  .replace(/^.*?·\s*(实时|近7天|近30天|全部)：(?=\S)/, "")
  .trim();

async function openCard(p) {
  const dup = st.cards.some((c) =>
    !["done", "cancelled"].includes(c.status) && topicOf(c.title) === topicOf(p.title));
  if (dup) return `跳过（同一件事已有未结卡）：${topicOf(p.title)}`;
  if (DRY) return `[dry] 会开 ${p.level}：${p.title}`;
  const r = await postJSON(`${BASE}/api/cards`, {
    title: p.title, why: p.why, deliverable: p.deliverable, done_def: p.done_def,
    level: p.level, owner: p.owner, check_day: p.check_day || 3, actor: "ceo",
  });
  if (!r.ok) return `开卡失败：${r.body?.error || r.error}`;
  return `开卡 #${r.body.id} ${p.level} -> ${p.owner}：${p.title}`;
}

async function raiseDecision(p) {
  const dup = st.decisions.some((d) => d.answer == null && topicOf(d.question) === topicOf(p.title));
  if (dup) return `跳过（这件事已经在你桌上）：${topicOf(p.title)}`;
  if (DRY) return `[dry] 会上报 P0：${p.title}`;
  const c = await postJSON(`${BASE}/api/cards`, {
    title: `【上报】${p.title}`, why: "CEO 判断：超出我的权限，必须你定",
    deliverable: p.recommendation, done_def: "你批了之后按范围执行", level: "P0",
    owner: "ceo", check_day: 2, actor: "ceo",
  });
  if (!c.ok) return `上报失败：${c.body?.error || c.error}`;
  const d = await postJSON(`${BASE}/api/cards/${c.body.id}/request-decision`, {
    question: p.title, recommendation: p.recommendation, cost: p.cost,
    scope: p.scope, silent_default: p.silent_default, asked_by: "ceo",
  });
  return d.ok ? `上报决策包 #${d.body.decision_id}：${p.title}（卡 #${c.body.id}）` : `决策包失败：${d.body?.error}`;
}

for (const p of plan) {
  done.push(p.kind === "card" ? await openCard(p) : await raiseDecision(p));
}

// 3.1 撤掉过期卡（店铺已删 / 数据源已恢复）
for (const x of autoCancel) {
  if (DRY) { done.push(`[dry] 会撤销 #${x.id}：${x.why}`); continue; }
  const r = await postJSON(`${BASE}/api/cards/${x.id}/status`, { status: "cancelled", actor: "ceo", note: x.why });
  done.push(r.ok ? `撤销 #${x.id}：${x.why}` : `撤销 #${x.id} 失败：${r.body?.error || r.error}`);
}

// -- 4. 写 CEO 日报 ---------------------------------------
const withData = rows.filter((r) => r.hasSource && r.alive);
const noData = rows.filter((r) => !r.hasSource);
const broken = rows.filter((r) => r.hasSource && (!r.alive || r.failedCount > 0));
const pendingDec = st.decisions.filter((d) => d.answer == null);

const summary =
  `今天 ${rows.length} 个业务 Agent：${withData.length} 个有数在跑、${broken.length} 个数据源出问题、${noData.length} 个还没接数据源；` +
  `未结卡 ${st.cards.filter((c) => !["done", "cancelled"].includes(c.status)).length} 张，` +
  `等我拍板 ${pendingDec.length} 件。` +
  (plan.length ? `本轮派活 ${plan.filter((p) => p.kind === "card").length} 件、上报 ${plan.filter((p) => p.kind === "decision").length} 件。` : "本轮没有新派活。");

console.log(`\n=== CEO Agent · ${today()} ===\n`);
console.log("各家状态：");
for (const r of rows) {
  const flags = [
    r.hasSource ? (r.alive ? "(o)" : "(~)") : "( )",
    `${r.metricLabel || "—"} ${r.metric}`,
    r.reported ? "已汇报" : "未汇报",
    r.openCards ? `${r.openCards} 张未结` : "无未结",
    r.dataStale ? "数据旧" : "数据新",
  ];
  console.log(`  ${r.agent.name.padEnd(16)} ${flags.join(" · ")}`);
}
console.log("\n判断与动作：");
if (!plan.length) console.log("  没有需要派活的");
done.forEach((d) => console.log(`  ${d}`));
console.log(`\nCEO 日报：${summary}`);
if (pendingDec.length) {
  console.log(`\n等你拍板（${pendingDec.length}）：`);
  pendingDec.slice(0, 6).forEach((d) => console.log(`  #${d.id} ${d.question}`));
}

if (!DRY) {
  const r = await postJSON(`${BASE}/api/reports`, {
    agent_id: "ceo", summary,
    payload: {
      withData: withData.length, broken: broken.length, noData: noData.length,
      planned: plan.length, pendingDecisions: pendingDec.length,
      actions: done.slice(0, 20),
    },
  });
  console.log(`\n日报已写：${r.ok ? "ok" : r.body?.error || r.error}`);
} else {
  console.log(`\n[dry] 没写库。`);
}


// ══════════════════════════════════════════════════════════════
// 每张卡推进一步：算出「下一步该谁干什么」，写回库
//   规则顺序（先命中先生效）：
//     1. 到期且逾期 ≥ 2 倍回看天数 → 升级（交到创始人桌上）
//     2. 到期没结                    → 催办
//     3. P0 且没批过决策             → 等你拍板（一步都不许动）
//     4. 状态 blocked                → 等对方解卡（催对方）
//     5. 状态 review                 → 等验收（你或 CEO 判 pass/fail）
//     6. 有执行器能自动干            → 可自动执行
//     7. 其它                        → 等对方交
// ══════════════════════════════════════════════════════════════
const AUTO_EXECUTABLE = new Set(["ship", "online", "offline", "price", "aftersale", "upload-image", "set-main-image"]);

// 逾期定义：过了约定回看日，再拖满 48 小时 = 48h 逾期（不是「天数翻倍」）
const OVERDUE_HOURS = Number(process.env.ESCALATE_AFTER_HOURS || 48);

function nextStepOf(card) {
  const gap = Math.floor((Date.now() - new Date(card.created_day + "T00:00:00+08:00").getTime()) / 86400000);
  const lateDays = gap - card.check_day;                       // 逾期天数（0 = 刚好到期）
  const due = lateDays >= 0;
  // 等验收的卡不升级：球在看的人手里，不是漏事，sweep 的 unverified 已经列出来了
  const ballAtOwner = !["review"].includes(card.status);

  if (due && ballAtOwner && lateDays * 24 >= OVERDUE_HOURS) {
    return {
      act: "升级", gap, lateDays,
      why: `第 ${card.check_day} 天该回看，今天第 ${gap} 天（逾期 ${lateDays} 天 ≥ 48h）—— 按规矩自动提到创始人桌上`,
    };
  }
  if (due) {
    return { act: "催办", gap, lateDays, why: `第 ${card.check_day} 天回看日已到（今天第 ${gap} 天），还没交东西` };
  }
  if (card.level === "P0" && !card.decision_id) {
    return { act: "等你拍板", gap, lateDays, why: "P0 大事没有决策包，一张卡也推不动" };
  }
  if (card.status === "blocked") return { act: "催对方解卡", gap, lateDays, why: "卡在别人那儿" };
  if (card.status === "review") return { act: "等验收", gap, lateDays, why: "交上来了，等判 pass/fail" };
  if (card.exec_mode === "auto") return { act: "可自动执行", gap, lateDays, why: "有执行器，能在闸门下直接跑" };
  return { act: "等对面交", gap, lateDays, why: `还没到第 ${card.check_day} 天（今天第 ${gap} 天）` };
}

function advanceCards() {
  const rows = db.prepare("SELECT * FROM cards WHERE status NOT IN ('done','cancelled')").all();
  const st = db.prepare("UPDATE cards SET next_action = ?, next_reason = ? WHERE id = ?");
  const out = [];
  for (const c of rows) {
    const s = nextStepOf(c);
    st.run(s.act, s.why, c.id);
    out.push({ id: c.id, level: c.level, owner: c.owner, status: c.status, decision_id: c.decision_id, title: c.title, act: s.act, why: s.why, gap: s.gap, lateDays: s.lateDays });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// 逾期 48 小时 → 自动开一张 P0 升级卡 + 决策包（不用等人想起来）
//   只升级「球还在执行方手里」的卡；等验收的不升级。
//   幂等：【升级】+ 原标题 的卡还开着就不再开。
//   限流：一轮最多 EScalate_MAX 张（默认 3），防止一次把台账刷爆。
// ══════════════════════════════════════════════════════════════
const ESCALATE_MAX = Number(process.env.ESCALATE_MAX_PER_ROUND || 3);

async function escalateOverdue(steps) {
  const openTitles = new Set(
    st.cards.filter((c) => !["done", "cancelled"].includes(c.status)).map((c) => String(c.title))
  );
  const cand = steps.filter((s) => s.act === "升级");
  if (!cand.length) return [];

  const out = [];
  let made = 0;
  for (const s of cand) {
    // 别再升级「升级卡」本身；已经有决策包的 P0 也已经在桌上了，不用再开一张
    if (String(s.title).startsWith("【升级】")) continue;
    if (s.level === "P0" && s.decision_id) continue;
    const title = `【升级】${s.title}`;
    if (openTitles.has(title)) { out.push(`#${s.id} 已有升级卡，跳过`); continue; }
    if (made >= ESCALATE_MAX) { out.push(`#${s.id} 本轮已开满 ${ESCALATE_MAX} 张，下轮再升`); continue; }
    if (DRY) { out.push(`[dry] 会开升级卡：${title}`); continue; }

    const c = await postJSON(`${BASE}/api/cards`, {
      title,
      level: "P0",
      owner: "ceo",
      check_day: 2,
      why: `原卡 #${s.id} 约定第 ${s.gap - (s.lateDays || 0)} 天回看，今天第 ${s.gap} 天，逾期 ${s.lateDays} 天（≥48h），球还在「${s.owner}」手里。按「逾期 48 小时自动升级」的规矩提到你桌上。`,
      deliverable: `对原卡 #${s.id} 给出结论，并落到决定库：继续 / 缩小范围 / 撤掉`,
      done_def: `决定库里有一条针对 #${s.id} 的结论；原卡状态随之改掉（继续→doing+写新回看日，缩小→改判据，撤掉→cancelled）`,
    });
    if (!c.ok) { out.push(`#${s.id} 开升级卡失败：${c.body?.error || c.error}`); continue; }

    let note = `开卡 #${c.body.id} P0`;
    const d = await postJSON(`${BASE}/api/cards/${c.body.id}/request-decision`, {
      question: `#${s.id}「${String(s.title).slice(0, 40)}」逾期 ${s.lateDays} 天没交，怎么处理？`,
      recommendation: `按原判据再给一个回看日继续跑；如果这件事已经不重要，直接撤掉，别占台账。`,
      cost: `继续 = 继续占「${s.owner}」的带宽；撤掉 = 前面投的时间认亏`,
      scope: `只动这一张卡（#${s.id}），不连带改别的`,
      silent_default: "不回 = 不动它，也不新增任何花费。",
      asked_by: "ceo",
    });
    note += d.ok ? ` -> 决策包 #${d.body.decision_id}（等你批）` : ` -> 决策包失败：${d.body?.error}`;
    openTitles.add(title);
    made++;
    out.push(`#${s.id} ${note}`);
  }
  return out;
}



// ══════════════════════════════════════════════════════════════
// 选品流水线：CEO 审核候选 → 通过才送到你面前
//   规则（可复算，不拍脑袋）：
//     毛利率 ≥ 30% 且 单数 ≥ 5   → 通过
//     毛利率 < 20%              → 否决（做也是白做）
//     落在中间                  → 通过，但标注「薄利，需你定价」
//   通过后 stage=owner_confirm，等你点头
// ══════════════════════════════════════════════════════════════
async function reviewPipeline() {
  // getJSON 返回 {ok,status,body}，数据在 body 里
  const res = await getJSON(`${BASE}/api/pipeline`).catch(() => ({ body: { items: [] } }));
  const list = res.body || { items: [] };
  const items = (list.items || []).filter((x) => x.stage === "ceo_review");
  if (!items.length) { console.log("\n选品：没有待审候选"); return; }

  console.log(`\n选品：待审 ${items.length} 条`);
  for (const it of items) {
    let ev = {};
    try { ev = JSON.parse(it.evidence || "{}"); } catch {}
    const rate = Number(ev.毛利率 ?? NaN);
    const orders = Number(ev.单数 ?? 0);

    let verdict = "pass", reason = "";
    // 市场机会型候选（选品 Agent 从罗盘扫出来的）：没有毛利/单数，用「需求侧」判
    if (ev.打分 && ev.机会原值) {
      const s = Number(ev.打分.总分) || 0;
      const dsr = Number(ev.机会原值.需求供给比) || 0;
      const g = Number(ev.机会原值.成交增速) || 0;
      if (g < 0) { verdict = "reject"; reason = `成交增速为负（${g}%），不做下行类目`; }
      else if (dsr && dsr < 3) { verdict = "reject"; reason = `需求供给比 ${dsr} < 3，供给已过剩`; }
      else if (s >= 70 && dsr >= 10) {
        verdict = "pass";
        reason = `机会分 ${s}（增速 ${g}% · 需供比 ${dsr}）—— 需求侧成立，拿货价要你问供应商（P0）`;
      } else if (s >= 50) {
        verdict = "pass";
        reason = `机会分 ${s} 偏中（增速 ${g}% · 需供比 ${dsr}）—— 可以看，但别一次备太多货`;
      } else {
        verdict = "reject"; reason = `机会分 ${s} < 50，不够撑一个新品`;
      }
    } else if (Number.isFinite(rate)) {
      if (rate >= 30 && orders >= 5) {
        verdict = "pass";
        reason = `毛利率 ${rate}%（≥30%）且卖出 ${orders} 单，结构值得复制`;
      } else if (rate < 20) {
        verdict = "reject";
        reason = `毛利率只有 ${rate}%，<20% —— 做这种品是白干`;
      } else {
        verdict = "pass";
        reason = `毛利率 ${rate}% 偏薄（20~30%），通过但必须你亲自定价`;
      }
    } else {
      verdict = "reject";
      reason = "缺成本数据，算不出毛利，不放到你面前";
    }

    console.log(`  #${it.id} ${String(it.name).slice(0, 26)} → ${verdict === "pass" ? "通过" : "否决"}`);
    console.log(`      ${reason}`);

    const nextStage = verdict === "pass" ? "owner_confirm" : "rejected";
    await postJSON(`${BASE}/api/pipeline/${it.id}/stage`, {
      stage: nextStage, ceo_verdict: verdict, ceo_reason: reason, actor: "ceo",
    });
  }

  const passed = items.length ? "见上" : "0";
  console.log(`  通过后已送到你面前（选品页「等你确认」列）`);
}

await reviewPipeline();

const steps = advanceCards();
const buckets = {};
for (const s of steps) (buckets[s.act] ||= []).push(s);

// 逾期 ≥48h 的，自动开 P0 升级卡 + 决策包（幂等、限流）
const escNotes = await escalateOverdue(steps);
if (escNotes.length) {
  console.log("\n【逾期自动升级】");
  escNotes.forEach((x) => console.log("  " + x));
}

console.log("\n【每张卡的下一步】");
for (const [act, list] of Object.entries(buckets)) {
  console.log(`\n  ▸ ${act}（${list.length} 张）`);
  for (const s of list) {
    console.log(`    #${s.id} [${s.level}] ${String(s.title).slice(0, 34)}`);
    console.log(`        → ${s.why}`);
  }
}
