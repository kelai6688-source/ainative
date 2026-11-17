#!/usr/bin/env node
/* auto.mjs —— 全自动循环（一轮）
 *
 *   node auto.mjs             # 拉数 -> 判规则 -> 开卡/派活 -> 巡视 -> 记账
 *   node auto.mjs --dry       # 只算不做
 *   node auto.mjs --no-sync   # 不拉数，只跑规则和巡视
 *
 * 一轮做四件事：
 *   1. node sync.mjs           真实数据进库（连接器说了算，拿不到就降级）
 *   2. 规则引擎                 automation.json 的 when 命中 -> 开卡
 *                              P0 只生成决策包（等人批），P1/P2 按 mode 处理
 *   3. POST /api/patrol        CEO 巡一轮：催到期、报卡住、提验收
 *   4. 记账                      本轮干了什么打到 stdout，写进 patrols / card_log
 *
 * 幂等：同名未结卡已存在就跳过，不会每 2 小时开一张重复卡。
 * 红线：P0 永远不自动开工 —— 这是这套东西存在的理由。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { postJSON, getJSON } from "./connectors/_http.mjs";

const run = promisify(execFile);
const ROOT = import.meta.dirname;
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const NO_SYNC = args.includes("--no-sync");

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "automation.json"), "utf8"));
const conn = JSON.parse(fs.readFileSync(path.join(ROOT, "connectors.json"), "utf8"));
const BASE = process.env.AINATIVE_URL || conn.base || "http://127.0.0.1:8788";
const MODE = cfg.mode || "assist";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const say = (...a) => console.log(...a);

// 把界面上的「+1.46 万」「$309」「58,843,658」都还原成数字再比阈值。
// 不做这一步的话 "+1.46 万" 会被当成 1.46，阈值 15000 永远命中 —— 假阳性。
function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,\s]/g, "");
  const m = s.match(/(-?\d+(?:\.\d+)?)(亿|万|k|K|M)?/);
  if (!m) return NaN;
  let n = Number(m[1]);
  const u = m[2];
  if (u === "万") n *= 1e4;
  else if (u === "亿") n *= 1e8;
  else if (u === "k" || u === "K") n *= 1e3;
  else if (u === "M") n *= 1e6;
  return n;
}

function cmp(a, op, b) {
  const x = parseNum(a);
  if (!Number.isFinite(x)) return false;
  switch (op) {
    case "<": return x < b;
    case "<=": return x <= b;
    case ">": return x > b;
    case ">=": return x >= b;
    case "==": return String(a) === String(b);
    case "!=": return String(a) !== String(b);
    default: return false;
  }
}

async function step1_sync() {
  if (NO_SYNC) { say("1) 拉数      跳过（--no-sync）"); return; }
  if (DRY) { say("1) 拉数      跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "sync.mjs")], { cwd: ROOT, windowsHide: true, timeout: 120000 });
    const lines = stdout.split("\n").filter((l) => /^[[OK][X]]/.test(l));
    say(`1) 拉数      ${lines.filter((l) => l.startsWith("[OK]")).length} 成功 / ${lines.filter((l) => l.startsWith("[X]")).length} 失败`);
    for (const l of lines) say("   " + l);
  } catch (e) {
    say(`1) 拉数      失败：${String(e.message || e).slice(0, 120)}`);
  }
}

async function step2_rules(state) {
  const rules = cfg.rules || [];
  const hits = [];

  for (const r of rules) {
    if (cfg.agents && cfg.agents[r.agent] === false) { say(`2) 规则 ${r.id}  -> 该 Agent 已关，跳过`); continue; }
    const agent = state.agents.find((a) => a.id === r.agent);
    if (!agent) { say(`2) 规则 ${r.id}  -> 没有这个 Agent`); continue; }

    let hit = false, actual = null;
    if (r.when.alive !== undefined) {
      hit = agent.alive === 0 && r.when.alive === false;
      actual = agent.alive ? "在岗" : "熄灯";
    } else {
      // 指标不匹配也允许命中（比如 label 改了），但要在输出里说清楚
      actual = agent.metric_value;
      hit = cmp(agent.metric_value, r.when.op, r.when.value);
    }
    if (!hit) { say(`2) 规则 ${r.id}  -> 没命中（${r.when.metric_label || "alive"} = ${actual}）`); continue; }

    const t = r.then;
    const exists = state.cards.some((c) => c.title === t.title && !["done", "cancelled"].includes(c.status));
    if (exists) { say(`2) 规则 ${r.id}  -> 命中，但已有同名未结卡，跳过`); continue; }

    hits.push({ r, t, actual });
  }

  if (!hits.length) { say("2) 规则      没有新命中"); return; }

  for (const { r, t, actual } of hits) {
    const body = {
      title: t.title,
      why: `自动规则 ${r.id} 命中：${r.when.metric_label || "alive"} = ${actual}（阈值 ${r.when.op} ${r.when.value ?? ""}）`,
      deliverable: t.deliverable,
      done_def: t.done_def,
      level: t.level || "P1",
      owner: r.agent,
      check_day: t.check_day || 3,
    };

    if (DRY) { say(`2) [dry] 会开卡：${t.title}  ${body.level}`); continue; }

    if (MODE === "off") { say(`2) mode=off，只报不开：${t.title}`); continue; }

    const c = await postJSON(`${BASE}/api/cards`, body);
    if (!c.ok) { say(`2) 开卡失败：${c.body?.error || c.error}`); continue; }

    let note = `开卡 #${c.body.id} ${body.level}`;
    if (body.level === "P0") {
      const d = await postJSON(`${BASE}/api/cards/${c.body.id}/request-decision`, {
        question: t.title,
        recommendation: `自动规则建议直接做：${t.deliverable}`,
        cost: "按 P0 走，需要你先看代价与范围",
        scope: t.deliverable,
        silent_default: "不回 = 不做，不花钱。",
        asked_by: r.agent,
      });
      note += d.ok ? ` -> 决策包 #${d.body.decision_id}（等你批）` : ` -> 决策包失败：${d.body?.error}`;
    } else if (MODE === "auto") {
      const s = await postJSON(`${BASE}/api/cards/${c.body.id}/status`, { status: "doing" });
      note += s.ok ? " -> 已自动开工" : ` -> 开工失败：${s.body?.error}`;
    } else {
      note += " -> 等 CEO 派（assist 模式）";
    }
    say(`2) 规则 ${r.id} -> ${note}`);
  }
}

async function step3_patrol() {
  if (DRY) { say("3) 巡视      跳过（--dry）"); return; }
  const p = await postJSON(`${BASE}/api/patrol`, {});
  if (!p.ok) { say(`3) 巡视      失败：${p.body?.error || p.error}`); return; }
  say(`3) 巡视      第 ${p.body.round} 轮，出手 ${p.body.actions.length} 次`);
  for (const a of p.body.actions) say(`   [${a.kind}] ${a.note}`);
}

async function step3_5_plan() {
  if (DRY) { say("3.5) 电商分析 跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "ecom-plan.mjs")], { cwd: ROOT, windowsHide: true, timeout: 180000 });
    const lines = stdout.split("\n").filter((l) => /【|[X]|!|方案|P\d-|交 CEO|必须你|汇报已写/.test(l));
    say(`3.5) 电商分析  真实数据 -> 诊断/方案/任务`);
    for (const l of lines.slice(0, 14)) say("   " + l.trim());
  } catch (e) {
    say(`3.5) 电商分析  失败：${String(e.message || e).slice(0, 120)}`);
  }
}

// 选品：从罗盘市场数据里挑机会 → 写候选 → 送 CEO 审核
// 它只产出「等你确认」的候选，不会自己上架（服务端也拦着）
async function step3_6_pick() {
  if (DRY) { say("3.6) 选品     跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "pick-agent.mjs")], { cwd: ROOT, windowsHide: true, timeout: 120000 });
    const lines = stdout.split("\n").filter((l) => /类目机会|产出候选|写入|已打卡|没有类目挖掘|⚠/.test(l));
    say(`3.6) 选品     罗盘机会 -> 候选 -> CEO 审核`);
    for (const l of lines.slice(0, 8)) say("   " + l.trim());
  } catch (e) {
    say(`3.6) 选品     失败：${String(e.message || e).slice(0, 120)}`);
  }
}

// 千川投流：拉计划数据 -> 判放量/控成本/关停 -> 该花钱的开决策包
async function step3_7_tc() {
  if (DRY) { say("3.7) 千川     跳过（--dry）"); return; }
  try {
    const s1 = await run(process.execPath, [path.join(ROOT, "sync.mjs"), "qianchuan"], { cwd: ROOT, windowsHide: true, timeout: 180000 });
    const okLine = s1.stdout.split("\n").find((l) => /^\[(OK|X)\]/.test(l.trim())) || "";
    say(`3.7) 千川     拉计划数据 ${okLine.trim().slice(0, 120)}`);

    const { stdout } = await run(process.execPath, [path.join(ROOT, "tc-agent.mjs")], { cwd: ROOT, windowsHide: true, timeout: 120000 });
    const lines = stdout.split("\n").filter((l) => /判断|空跑|放量|控成本|关停|写入建议|决策包/.test(l));
    for (const l of lines.slice(0, 8)) say("   " + l.trim().replace(/\x1b\[[0-9;]*m/g, ""));
  } catch (e) {
    say(`3.7) 千川     失败：${String(e.message || e).slice(0, 120)}`);
  }
}

async function step4_ceo() {
  if (DRY) { say("4) CEO      跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "ceo.mjs")], { cwd: ROOT, windowsHide: true, timeout: 120000 });
    const lines = stdout.split("\n").filter((l) => /开卡|上报|跳过|跳过（|日报/.test(l));
    say(`4) CEO      收汇报 -> 分析 -> 派活`);
    for (const l of lines.slice(0, 12)) say("   " + l.trim());
  } catch (e) {
    say(`4) CEO      失败：${String(e.message || e).slice(0, 120)}`);
  }
}

async function step4_5_worker() {
  if (DRY) { say("4.5) AI执行   跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "agent-worker.mjs")], { cwd: ROOT, windowsHide: true, timeout: 240000 });
    const lines = stdout.split("\n").filter((l) => /AI 能干|只能人干|交活|失败|待你验收/.test(l));
    if (!lines.length) { say("4.5) AI执行   没有需要干的卡"); return; }
    say(`4.5) AI执行   AI 领卡 -> 出交付物 -> 等你验收`);
    for (const l of lines.slice(0, 12)) say("   " + l.trim());
  } catch (e) {
    say(`4.5) AI执行   失败：${String(e.message || e).slice(0, 120)}`);
  }
}

// 验收单：把「待验收」的卡按 done_def 拆成可核 / 要人判两类。
// 只读不落库 —— 自动通过判错一次，整套台账就没人信了。
async function step5_verify() {
  if (DRY) { say("5) 验收单    跳过（--dry）"); return; }
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, "verify.mjs")], { cwd: ROOT, windowsHide: true, timeout: 60000 });
    const lines = stdout.split("\n");
    const head = (lines.find((l) => l.includes("验收单 ·")) || "").trim();
    const n = { pass: 0, fail: 0, wait: 0, human: 0 };
    for (const l of lines) {
      if (!l.includes("结论建议")) continue;
      if (l.includes("自动通过")) n.pass++;
      else if (l.includes("退回")) n.fail++;
      else if (l.includes("未到期")) n.wait++;
      else n.human++;
    }
    say(`5) 验收单    ${head.replace(/\x1b\[[0-9;]*m/g, "")}`);
    say(`   自动通过 ${n.pass} · 退回 ${n.fail} · 未到期 ${n.wait} · 要你看 ${n.human}`);
  } catch (e) {
    say(`5) 验收单    失败：${String(e.message || e).slice(0, 120)}`);
  }
}

async function main() {  say(`\n=== auto.mjs · ${stamp()} · mode=${MODE}${DRY ? " · DRY" : ""} ===\n`);

  const before = await getJSON(`${BASE}/api/state`);
  if (!before.ok) { console.error(`连不上 ${BASE}，先 node server.mjs`); process.exit(1); }

  await step1_sync();
  const mid = DRY ? before.body : (await getJSON(`${BASE}/api/state`)).body;
  await step2_rules(mid);
  await step3_patrol();
  await step3_5_plan();
  await step3_6_pick();
  await step3_7_tc();
  await step4_ceo();
  await step4_5_worker();
  await step5_verify();

  const after = (await getJSON(`${BASE}/api/state`)).body;
  const sw = after.sweep;
  say(`\n本轮结束：在办 ${after.cards.filter((c) => !["done", "cancelled"].includes(c.status)).length} 件 · ` +
      `等你 ${(sw.need_decision || []).length + sw.stuck.length + sw.unverified.length + sw.silent_decisions.length + sw.due_criteria.length + sw.overdue.length} 件 · ` +
      `在岗 ${after.agents.filter((a) => a.alive).length}/${after.agents.length}`);
  if (MODE === "auto") say("mode=auto：P1 会自动开工；**P0 仍然卡在决策包，等你点头**。");
}

main().catch((e) => { console.error("auto 崩了：", e); process.exit(1); });
