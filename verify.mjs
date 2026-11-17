#!/usr/bin/env node
/* verify.mjs —— done_def 自动核对（能给机器判的机器判，给不了的列出来让人判）
 *
 *   node verify.mjs                 # 只出「验收单」，不改库
 *   node verify.mjs --apply         # 只自动落两种结论：证据缺失 → 退回重做；判据全可机器核 → 通过
 *   node verify.mjs --card 49       # 只看某一张
 *
 * 为什么不是「AI 自己判自己」：
 *   验收方必须和执行方分开。这里以 ceo 名义验，执行的是 shop/ai。
 *   而且只有「机器真能读到数」的判据才自动判，读不到的一律标「要你看」，
 *   不猜、不糊过去 —— 判错一次，整套台账就没人信了。
 *
 * 判据分类（done_def 按句拆）：
 *   时间类   「跑满 7 天」「第 7 天…」      -> 交活后没满天数 = 未到期，不许验
 *   人判类   「经你确认」「你定」           -> 只能人判
 *   数值类   「≥ 4%」「跌幅不超过 30%」      -> 要平台读数，机器没有 = 人判
 *   交付物类 「一张表」「清单」「文案」      -> 证据文件在不在、空不空（机器可核）
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const APPLY = process.argv.includes("--apply");
const onlyArg = (() => {
  const i = process.argv.indexOf("--card");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", b: "\x1b[36m",
};

async function getJSON(u) {
  const r = await fetch(BASE + u);
  return r.json();
}
async function postJSON(u, body) {
  const r = await fetch(BASE + u, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

// ── 判据拆句 ────────────────────────────────────────────────
function splitCriteria(doneDef) {
  return String(doneDef || "")
    .split(/[；;、]|，且|并且|以及|，同时/)
    .map((s) => s.replace(/^[，,、\s]+|[，,、\s。]+$/g, ""))
    .filter(Boolean);
}

const RE_DAYS = /(?:跑满|满|第)\s*(\d+)\s*天|(\d+)\s*天后|(\d+)\s*天/;
const RE_HUMAN = /经你|你确认|你定|你拍板|你决定|人工/;
const RE_NUM = /[≥≤＞＜<>]|不超过|超过|低于|高于|跌\s*\d|\d+(?:\.\d+)?\s*%/;
const RE_ARTIFACT = /表|清单|文案|主图|图|计划|报告|方案|记录|截图/;

function classify(clause) {
  if (RE_HUMAN.test(clause)) return "human";
  if (RE_NUM.test(clause)) return "metric";
  if (RE_DAYS.test(clause)) return "time";
  if (RE_ARTIFACT.test(clause)) return "artifact";
  return "other";
}

// 从「交活」日志里抠证据路径
function evidenceOf(logs) {
  const subs = logs.filter((l) => l.action === "交活");
  if (!subs.length) return null;
  const last = subs[subs.length - 1];
  const m = String(last.note || "").match(/证据[:：]\s*(.+)$/);
  return { at: last.at, by: last.actor, path: m ? m[1].trim() : null, note: last.note };
}

function resolveEvidence(p) {
  if (!p) return null;
  const cand = [path.resolve(ROOT, p), path.resolve(ROOT, "..", p), p];
  for (const c of cand) {
    try { if (fs.statSync(c).isFile()) return { file: c, size: fs.statSync(c).size }; } catch {}
  }
  return null;
}

function daysSince(iso) {
  return (Date.now() - Date.parse(iso)) / 86400000;
}

const state = await getJSON("/api/state");
const review = (state.cards || []).filter((c) => c.status === "review" && (!onlyArg || c.id === onlyArg));

if (!review.length) {
  console.log("没有「待验收」的卡。");
  process.exit(0);
}

const results = [];
for (const c of review) {
  const detail = await getJSON(`/api/cards/${c.id}`);
  const ev = evidenceOf(detail.logs || []);
  const file = ev ? resolveEvidence(ev.path) : null;
  const clauses = splitCriteria(c.done_def).map((t) => ({ text: t, kind: classify(t) }));

  const machine = [];
  const pending = [];
  const human = [];

  // 1) 证据本身在不在（这是唯一能硬判的）
  if (!ev) {
    machine.push({ ok: false, text: "没有「交活」记录 —— 卡不该在待验收" });
  } else if (!ev.path) {
    machine.push({ ok: false, text: "交活没写证据路径" });
  } else if (!file) {
    machine.push({ ok: false, text: `证据文件找不到：${ev.path}` });
  } else {
    machine.push({ ok: true, text: `证据文件在：${ev.path}（${(file.size / 1024).toFixed(1)} KB）` });
  }

  // 2) 逐句判据
  for (const cl of clauses) {
    if (cl.kind === "artifact") {
      machine.push({ ok: !!file, text: `[交付物] ${cl.text} → ${file ? "文件已交，内容对不对要人看" : "文件没交"}` });
      if (file) human.push(cl.text);
    } else if (cl.kind === "time") {
      const m = cl.text.match(RE_DAYS);
      const need = Number(m?.[1] || m?.[2] || m?.[3] || 0);
      if (ev?.at && need) {
        const passed = daysSince(ev.at);
        if (passed < need) pending.push(`[未到期] ${cl.text} —— 交活才 ${passed.toFixed(1)} 天，还差 ${(need - passed).toFixed(1)} 天`);
        else human.push(`[时间已满] ${cl.text}（已 ${passed.toFixed(1)} 天，数据对不对要人看）`);
      } else human.push(cl.text);
    } else if (cl.kind === "metric") {
      human.push(`[要平台读数] ${cl.text}`);
    } else if (cl.kind === "human") {
      human.push(`[只能你判] ${cl.text}`);
    } else {
      human.push(cl.text);
    }
  }

  const hardFail = machine.some((m) => !m.ok);
  const suggestion = hardFail ? "fail" : pending.length ? "wait" : human.length ? "human" : "pass";

  results.push({ card: c, ev, file, machine, pending, human, suggestion });
}

// ── 打印验收单 ──────────────────────────────────────────────
console.log(`\n验收单 · ${results.length} 张待验收 · ${new Date().toLocaleString("zh-CN", { hour12: false })}\n`);
for (const r of results) {
  const c = r.card;
  const tag = { pass: `${C.ok}自动通过${C.reset}`, fail: `${C.bad}退回${C.reset}`, wait: `${C.warn}未到期${C.reset}`, human: `${C.b}要你看${C.reset}` }[r.suggestion];
  console.log(`${C.dim}${"─".repeat(70)}${C.reset}`);
  console.log(`#${c.id} [${c.level}] ${c.title}`);
  console.log(`  判据：${c.done_def}`);
  console.log(`  结论建议：${tag}`);
  for (const m of r.machine) console.log(`  ${m.ok ? C.ok + "✔" : C.bad + "✘"}${C.reset} ${m.text}`);
  for (const p of r.pending) console.log(`  ${C.warn}⏳${C.reset} ${p}`);
  for (const h of r.human) console.log(`  ${C.dim}人${C.reset} ${h}`);
}

// ── 落库 ────────────────────────────────────────────────────
if (APPLY) {
  console.log(`\n落库（只落两种：退回 / 全机器可核）：`);
  for (const r of results) {
    if (r.suggestion === "fail") {
      const res = await postJSON(`/api/cards/${r.card.id}/verdict`, {
        verdict: "fail", verifier: "ceo",
        note: `自动核对退回：${r.machine.filter((m) => !m.ok).map((m) => m.text).join("；")}`,
      });
      console.log(`  #${r.card.id} 退回 ${res.ok ? "ok" : res.body?.error || "失败"}`);
    } else if (r.suggestion === "pass") {
      const res = await postJSON(`/api/cards/${r.card.id}/verdict`, {
        verdict: "pass", verifier: "ceo",
        note: `自动核对通过：${r.machine.map((m) => m.text).join("；")}`,
      });
      console.log(`  #${r.card.id} 通过 ${res.ok ? "ok" : res.body?.error || "失败"}`);
    } else {
      console.log(`  #${r.card.id} 留给你（${r.suggestion === "wait" ? "未到期" : "有判据机器读不到"}）`);
    }
  }
} else {
  console.log(`\n（只是验收单，没改库。要落库：node verify.mjs --apply）`);
}
