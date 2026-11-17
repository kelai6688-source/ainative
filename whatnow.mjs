// 看电商 Agent 最新一次汇报：它自己干什么、交给 CEO 什么、上报你什么
import { db } from "./db.mjs";

const r = db.prepare(
  "SELECT id, agent_id, day, summary, payload_json, created_at FROM reports WHERE agent_id = 'shop' ORDER BY id DESC LIMIT 1"
).get();

if (!r) { console.log("没有 shop 的汇报"); process.exit(0); }

let p = {};
try { p = JSON.parse(r.payload_json || "{}"); } catch {}

console.log(`汇报 #${r.id}  ${r.created_at || r.day || ""}  kind=${p.kind || "?"}`);
console.log(`摘要：${String(r.summary || "").slice(0, 220)}\n`);

const tasks = p.tasks || [];
const escs = p.escalations || [];
const diag = (p.diagnose || []).filter((d) => d.lv !== "info");
const plans = p.plans || [];

console.log(`【诊断异常】${diag.length} 项`);
for (const d of diag) console.log(`  [${d.lv}] ${d.t}`);

console.log(`\n【方案】${plans.length} 条`);
for (const x of plans) console.log(`  [${x.pri}] ${x.id}：${x.what}`);

console.log(`\n【它开出来的卡】${tasks.length} 条`);
for (const t of tasks) {
  console.log(`  [${t.level}] owner=${t.owner === "S" ? "你" : t.owner}  ${t.title}`);
  if (t.done_def) console.log(`         判据：${String(t.done_def).slice(0, 70)}`);
}

console.log(`\n【必须你拍板】${escs.length} 条`);
for (const e of escs) {
  console.log(`  [P0] ${e.title}`);
  if (e.cost) console.log(`       代价：${String(e.cost).slice(0, 70)}`);
  if (e.silent_default) console.log(`       不回：${String(e.silent_default).slice(0, 70)}`);
}

const open = db.prepare(
  "SELECT id, level, owner, title, status FROM cards WHERE owner IN ('shop','shop_demo','S') AND status NOT IN ('done','cancelled') ORDER BY id"
).all();
console.log(`\n【台账里电商相关未结卡】${open.length} 张`);
for (const c of open) console.log(`  #${c.id} ${c.level} ${c.owner === "S" ? "你" : c.owner}  [${c.status}]  ${String(c.title).slice(0, 52)}`);

const pend = db.prepare("SELECT id, question, asked_by FROM decisions WHERE answer IS NULL").all();
console.log(`\n【等你拍板】${pend.length} 件`);
for (const d of pend) console.log(`  #${d.id}（${d.asked_by} 提出）${String(d.question).slice(0, 60)}`);
