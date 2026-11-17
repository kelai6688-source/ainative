#!/usr/bin/env node
/* tc-agent.mjs —— 千川投流 Agent：分析计划 → 出建议 → 该花的要你先点头
 *
 *   node tc-agent.mjs            # 分析 + 写建议 + 该上报的开决策包
 *   node tc-agent.mjs --dry      # 只看结论不写库
 *
 * 它判什么（规则写死，可复算；所有数字来自 tc_ads / tc_snapshot，不猜）：
 *   R0 学习期       learning≠0            → 不动，只记录
 *   R1 空跑         在投 且 近7天消耗<¥1   → 查素材/出价（P1，不花钱）
 *   R2 可放量       ROI≥目标×1.2 且 7天消耗≥30 → 预算 +30%（P0：花钱，要批）
 *   R3 该控成本     ROI<目标×0.8 且 7天消耗≥30 → 预算 -20% 或降价（P0：动钱，要批）
 *   R4 该关停       ROI<保本ROI 且 7天消耗≥50  → 关停（P0：停钱，要批）
 *   R5 观察         其余
 *
 * 边界（必须说清）：
 *   ① 写操作接口没抓到，所以它**不会自己去改预算/出价/关计划**，
 *      只给「改多少 + 依据 + 后台在哪点」，执行前要你批（决策包）。
 *   ② 素材维度接口当前不可用（material_id 超时），素材分析只能到「计划绑的素材数」级别。
 */

import fs from "node:fs";
import { db } from "./db.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const DRY = process.argv.includes("--dry");
const C = { r: "\x1b[0m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[36m", red: "\x1b[31m" };
const yuan = (n) => `¥${(Number(n) || 0).toFixed(2)}`;

// 保本 ROI：优先读 ecom.config.json 里手填的，没有就用 2.9（本店近30天摊完投放的保本线）
function breakevenRoi() {
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
    const v = cfg.breakevenRoi ?? cfg.defaults?.breakevenRoi ?? cfg.shops?.shop_demo?.breakevenRoi;
    if (Number(v) > 0) return { v: Number(v), from: "ecom.config.json" };
  } catch {}
  return { v: 2.9, from: "默认 2.9（近30天摊投放后估）" };
}

async function post(u, body) {
  const r = await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

const snap = db.prepare("SELECT * FROM tc_snapshot ORDER BY id DESC LIMIT 1").get();
const ads = db.prepare("SELECT * FROM tc_ads ORDER BY COALESCE(cost,0) DESC").all();
if (!ads.length) {
  console.error(`${C.red}没有千川计划数据${C.r}。先跑：node sync.mjs qianchuan`);
  process.exit(2);
}

const be = breakevenRoi();
const ageH = snap ? (Date.now() - Date.parse(snap.at)) / 3600000 : null;

console.log(`\n=== 千川投流 Agent ===`);
console.log(`账户：余额 ${snap ? yuan(snap.balance) : "—"} · 今日消耗 ${snap ? yuan(snap.cost_today) : "—"} · 计划 ${ads.length} 个`
  + (ageH != null ? ` · 数据 ${ageH < 1 ? "刚刚" : ageH.toFixed(1) + " 小时前"}` : ""));
if (ageH != null && ageH > 2) console.log(`${C.y}⚠ 数据超过 2 小时没更新，下面按旧数算${C.r}`);
console.log(`保本 ROI：${be.v}（${be.from}）\n`);

console.log(`${C.d}计划                          状态    预算   目标ROI  7天消耗   7天ROI   今日${C.r}`);
for (const a of ads) {
  let raw = {}; try { raw = JSON.parse(a.raw || "{}"); } catch {}
  const cost7 = raw.d7?.cost ?? null;
  const roi7 = raw.d7?.cost > 0 ? +(raw.d7.gmv / raw.d7.cost).toFixed(2) : null;
  console.log(
    `  ${String(a.name).padEnd(28).slice(0, 28)} ${String(a.status || "").padEnd(6)} `
    + `${String(yuan(a.budget)).padStart(7)} ${String(a.roi_goal ?? "—").padStart(7)} `
    + `${String(cost7 == null ? "—" : yuan(cost7)).padStart(9)} ${String(roi7 ?? "—").padStart(8)} ${yuan(a.cost).padStart(8)}`
  );
}

// ── 规则 ────────────────────────────────────────────────
function judge(a) {
  let raw = {}; try { raw = JSON.parse(a.raw || "{}"); } catch {}
  const d7 = raw.d7 || {};
  const d30 = raw.d30 || {};
  const cost7 = Number(d7.cost || 0);
  const gmv7 = Number(d7.gmv || 0);
  const cost30 = Number(d30.cost || 0);
  const roi7 = cost7 > 0 ? gmv7 / cost7 : null;
  const goal = Number(a.roi_goal) || null;
  const nums = {
    cost7d: +cost7.toFixed(2), gmv7d: +gmv7.toFixed(2),
    roi7d: roi7 == null ? null : +roi7.toFixed(2),
    cost30d: +cost30.toFixed(2), roi30d: d30.cost > 0 ? +(d30.gmv / d30.cost).toFixed(2) : null,
    roiGoal: goal, breakeven: be.v, budget: a.budget, costToday: a.cost,
  };

  if (Number(a.learning) > 0) return { action: "学习期不动", level: "P2", nums, reason: "系统还在学习期，这时候动它等于把学习成果清零" };
  if (/投放中|开启/.test(String(a.status)) && cost7 < 1) {
    return {
      action: "空跑", level: "P1", nums,
      reason: cost30 < 1
        ? `在投但近30天一分钱没花（¥${cost30.toFixed(2)}）—— 从没起量：素材没过审/出价低于建议/商品被限流，先去后台看「计划诊断」`
        : `在投但近7天花了 ¥${cost7.toFixed(2)}，而近30天花过 ¥${cost30.toFixed(2)} —— 计划停摆了：查余额、素材衰退、还是被系统降权`,
    };
  }
  if (roi7 != null && goal && roi7 >= goal * 1.2 && cost7 >= 30) {
    return { action: "放量", level: "P0", nums, reason: `实际 ROI ${roi7.toFixed(2)} 高于目标 ${goal} 的 1.2 倍，7天花了 ${yuan(cost7)} 还赚 —— 加预算拿更多量` };
  }
  if (roi7 != null && goal && roi7 < goal * 0.8 && cost7 >= 30) {
    return { action: "控成本", level: "P0", nums, reason: `实际 ROI ${roi7.toFixed(2)} 低于目标 ${goal} 的 0.8 倍，7天已花 ${yuan(cost7)} —— 要么降预算，要么降价/换素材` };
  }
  if (roi7 != null && roi7 < be.v && cost7 >= 50) {
    return { action: "关停", level: "P0", nums, reason: `ROI ${roi7.toFixed(2)} 低于保本线 ${be.v}，7天已烧 ${yuan(cost7)} —— 继续跑就是净亏` };
  }
  return { action: "观察", level: "P2", nums, reason: cost7 < 30 ? "样本太小（7天消耗不足 ¥30），现在下结论是拍脑袋" : "指标没触发任何阈值" };
}

const judged = ads.map((a) => ({ a, v: judge(a) }));
const byAction = {};
for (const j of judged) (byAction[j.v.action] ||= []).push(j);

console.log(`\n判断：`);
for (const [act, list] of Object.entries(byAction)) {
  const color = act === "关停" ? C.red : act === "放量" ? C.g : act === "空跑" ? C.y : C.d;
  console.log(`  ${color}${act}${C.r} ${list.length} 个`);
  for (const j of list.slice(0, 4)) console.log(`     ${String(j.a.name).slice(0, 26)} — ${j.v.reason.slice(0, 60)}`);
}

if (DRY) { console.log("\n[dry] 没写库"); process.exit(0); }

// ── 写建议（同一计划同一动作 6 小时内不重复写）────────────
const recent = db.prepare("SELECT ad_id, action, at FROM tc_advice WHERE at > ?").all(new Date(Date.now() - 6 * 3600000).toISOString());
const seen = new Set(recent.map((r) => `${r.ad_id}|${r.action}`));
let written = 0, madeDecisions = 0;

for (const { a, v } of judged) {
  if (v.action === "观察") continue;
  const key = `${a.ad_id}|${v.action}`;
  if (seen.has(key)) continue;
  seen.add(key);

  let decisionId = null;
  // P0：花钱/停钱的事，开决策包等拍板（一轮最多 2 个，别刷屏）
  if (v.level === "P0" && madeDecisions < 2) {
    const card = await post("/api/cards", {
      title: `千川｜${v.action}：${String(a.name).slice(0, 20)}`,
      why: v.reason,
      deliverable: `在千川后台对「${a.name}」执行：${v.action === "放量" ? `日预算 ${yuan(a.budget)} → ${yuan(a.budget * 1.3)}` : v.action === "控成本" ? `日预算 ${yuan(a.budget)} → ${yuan(a.budget * 0.8)}` : "暂停该计划"}`,
      done_def: `后台已生效（截图或后台数值可查），且 24 小时内复查消耗与 ROI 变化`,
      level: "P0",
      owner: "tc",
      check_day: 1,
    });
    if (card.ok) {
      const d = await post(`/api/cards/${card.body.id}/request-decision`, {
        question: `千川计划「${String(a.name).slice(0, 24)}」${v.action}，做不做？`,
        recommendation: v.reason,
        cost: v.action === "放量"
          ? `预算从 ${yuan(a.budget)} 提到 ${yuan(a.budget * 1.3)}，一天最多多花 ${yuan(a.budget * 0.3)}`
          : v.action === "控成本"
            ? `预算从 ${yuan(a.budget)} 压到 ${yuan(a.budget * 0.8)}，少拿一部分量`
            : `停掉这个计划，7天已花 ${yuan(v.nums.cost7d)} 认亏`,
        scope: `只动这一条计划（${a.ad_id}），不动账户预算、不动别的计划`,
        silent_default: "不回 = 什么都不改，计划按现状继续跑，不额外花钱也不停投",
        asked_by: "tc",
      });
      decisionId = d.ok ? d.body.decision_id : null;
      if (d.ok) madeDecisions++;
    }
  }

  const r = await post("/api/tc/advice", {
    ad_id: a.ad_id, ad_name: a.name, action: v.action, level: v.level,
    reason: v.reason, numbers: v.nums, decision_id: decisionId,
  });
  if (r.ok) written++;
}

console.log(`\n写入建议 ${written} 条${madeDecisions ? `，开决策包 ${madeDecisions} 个（等你批）` : ""}`);

// ── 素材库：审核 / 质量 ──────────────────────────────────
const mats = db.prepare("SELECT * FROM tc_materials").all();
let matBad = 0, matLow = 0, matGood = 0, matPending = 0;
if (mats.length) {
  // 审核码：1=通过，2=不通过，0=待审/未知（对着素材库页面核对过）
  matBad = mats.filter((m) => m.audit === 2).length;
  matPending = mats.filter((m) => m.audit === 0).length;
  matLow = mats.filter((m) => m.low_eff).length;
  matGood = mats.filter((m) => m.high_q).length;
  console.log(`\n素材库：${mats.length} 条 · 通过 ${mats.length - matBad - matPending} / 不通过 ${matBad} / 待审 ${matPending}`
    + `${matLow ? ` · 低效 ${matLow}` : ""}${matGood ? ` · 优质 ${matGood}` : ""}`);
  for (const m of mats.filter((x) => x.audit === 2).slice(0, 3)) console.log(`   不通过：${String(m.title).slice(0, 40)}`);

  // 素材级消耗/ROI：有消耗但 ROI 低于保本线 → 停这个素材
  const spenders = mats.filter((m) => Number(m.cost) > 0).sort((a, b) => Number(b.cost) - Number(a.cost));
  if (spenders.length) {
    console.log(`   有消耗素材 ${spenders.length} 条：` + spenders.slice(0, 5).map((m) => `${String(m.title).slice(0, 12)} ¥${Number(m.cost).toFixed(2)}/ROI ${m.roi ?? "—"}`).join(" · "));
    const badSpend = spenders.filter((m) => Number(m.cost) >= 20 && (m.roi == null || Number(m.roi) < be.v));
    for (const m of badSpend.slice(0, 3)) {
      const dup = db.prepare("SELECT 1 FROM tc_advice WHERE ad_id = ? AND action = '停素材' AND at > ?")
        .get(String(m.item_id), new Date(Date.now() - 12 * 3600000).toISOString());
      if (dup) continue;
      await post("/api/tc/advice", {
        ad_id: String(m.item_id), ad_name: String(m.title).slice(0, 40), action: "停素材", level: "P1",
        reason: `这条素材花了 ¥${Number(m.cost).toFixed(2)}，ROI ${m.roi == null ? "无成交" : Number(m.roi).toFixed(2)} 低于保本 ${be.v} —— 继续投就是烧钱`,
        numbers: { cost: m.cost, roi: m.roi, ctr: m.ctr, cvr: m.cvr, breakeven: be.v },
      });
      written++;
    }
  }

  if (matBad > 0) {
    const dup = db.prepare("SELECT 1 FROM tc_advice WHERE ad_id='materials' AND action='换素材' AND at > ?")
      .get(new Date(Date.now() - 12 * 3600000).toISOString());
    if (!dup) {
      await post("/api/tc/advice", {
        ad_id: "materials", ad_name: "千川素材库", action: "换素材", level: "P1",
        reason: `${matBad} 条视频审核不通过（占 ${(matBad / mats.length * 100).toFixed(0)}%）—— 这些投不出去，先按「审核建议」改画面/口播再来`,
        numbers: { total: mats.length, failed: matBad, pending: matPending, lowEff: matLow, highQuality: matGood },
      });
      written++;
    }
  }
}

// ── 汇报 + 打卡 ─────────────────────────────────────────
try {
  const hot = judged.filter((j) => j.v.level === "P0").length;
  await post("/api/reports", {
    agent_id: "tc",
    summary: `千川巡检：${ads.length} 个计划，今日消耗 ${yuan(snap?.cost_today || 0)}、ROI ${snap?.roi_today ?? "—"}；`
      + `需要你拍板 ${hot} 个（${Object.entries(byAction).filter(([k]) => k !== "观察").map(([k, v]) => `${k}${v.length}`).join(" / ")}）`,
    payload: { plans: ads.length, costToday: snap?.cost_today, roiToday: snap?.roi_today, advice: written, hot },
  });
  await post("/api/agents/tc/heartbeat", {
    alive: true,
    metric_value: `${ads.length} 个计划`,
    metric_label: "千川在投",
    metric_extra: `今日消耗 ${yuan(snap?.cost_today || 0)} · ROI ${snap?.roi_today ?? "—"}`,
    next_run_at: new Date(Date.now() + 30 * 60000).toISOString(),
  });
  console.log("已打卡：千川 Agent 在岗");
} catch (e) {
  console.log("打卡失败（不影响结果）：", String(e.message || e).slice(0, 80));
}
