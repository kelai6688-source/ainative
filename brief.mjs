// brief.mjs —— 治理侧早报生成器（纯规则，不依赖模型）
// 只报「台账里真实算得出来的事」：到期、卡住、待验收、到点读数、没人回。
// 平台侧数据（流量 / 订单 / 评论）要接 Amazon SP-API + Printful 才能有，不在这里编。
import { db, today, dayGap, nowIso } from "./db.mjs";
import { fileURLToPath } from "node:url";

const cards = db.prepare("SELECT * FROM cards").all();
const crit = db.prepare("SELECT * FROM criteria").all();
const decs = db.prepare("SELECT * FROM decisions").all();

const live = cards.filter((c) => !["done", "cancelled"].includes(c.status));
const overdue = live.filter((c) => dayGap(c.created_day) >= c.check_day);
const stuck = live.filter((c) => c.status === "blocked");
const review = live.filter((c) => c.status === "review");
const dueCrit = crit.filter((k) => k.verdict == null && dayGap(k.created_day) >= k.read_day);
const silent = decs.filter((d) => d.answer == null && dayGap(d.created_at.slice(0, 10)) >= 1);

const n = (x, s = "件") => `${x} ${s}`;

const items = [
  {
    label: "台账",
    tone: overdue.length ? "warn" : "ok",
    text: overdue.length
      ? `${n(live.length)}在跑，其中 ${n(overdue.length)}到期没动：${overdue[0].title}`
      : `${n(live.length)}在跑，没有到期的`,
  },
  {
    label: "判据",
    tone: dueCrit.length ? "warn" : "ok",
    text: dueCrit.length
      ? `${n(dueCrit.length, "个")}到点该读数：${dueCrit[0].batch}（第 ${dueCrit[0].read_day} 天）`
      : "没有到点的判据",
  },
  {
    label: "决策",
    tone: silent.length ? "bad" : "ok",
    text: silent.length
      ? `${n(silent.length, "个")}决策包没人回 → 按默认不做：${silent[0].question}`
      : "没有欠我的决定",
  },
  {
    label: stuck.length ? "异常" : "验收",
    tone: stuck.length ? "bad" : review.length ? "warn" : "ok",
    text: stuck.length
      ? `${n(stuck.length)}卡住要报我：${stuck.map((s) => s.title).slice(0, 2).join("、")}`
      : review.length
        ? `${n(review.length)}待验收：${review[0].title}`
        : "没有卡住的，也没有待验收的",
  },
];

const urgent = stuck.length + silent.length + dueCrit.length + review.length + overdue.length;
const headline =
  urgent === 0 ? "全部正常，今天不用你" : urgent === 1 ? "一处要看，其余正常" : `${urgent} 处要看`;

// 建议：按「先止血、再清账、再读数」的顺序挑一件，且必须可执行
let suggestion;
if (stuck.length) {
  suggestion = `先看卡住的「${stuck[0].title}」（${stuck[0].owner}）：要么给条件，要么砍掉，别让它挂着。`;
} else if (silent.length) {
  suggestion = `「${silent[0].question}」已经躺了 ${dayGap(silent[0].created_at.slice(0, 10))} 天，按默认就是「${silent[0].silent_default}」。今天要么回一句，要么接受不做。`;
} else if (dueCrit.length) {
  suggestion = `「${dueCrit[0].batch}」到第 ${dueCrit[0].read_day} 天，按写好的标准读，别提前找理由。`;
} else if (review.length) {
  suggestion = `验收「${review[0].title}」：判据是「${review[0].done_def}」，对不上就退回。`;
} else if (overdue.length) {
  suggestion = `催「${overdue[0].title}」（${overdue[0].owner}）：已过 ${dayGap(overdue[0].created_day)} 天，约定第 ${overdue[0].check_day} 天。`;
} else {
  suggestion = "没有要你动手的。今天的时间拿去做方向，不是做杂事。";
}

export function generateBrief() {
  const t = nowIso();
  const info = db
    .prepare("INSERT INTO briefs (day,headline,items_json,suggestion,source,created_at) VALUES (?,?,?,?,?,?)")
    .run(today(), headline, JSON.stringify(items), suggestion, "ledger", t);
  return { id: Number(info.lastInsertRowid), day: today(), headline, items, suggestion, source: "ledger", counted: { urgent } };
}

// 直接跑：node brief.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const b = generateBrief();
  console.log(`[${b.day}] ${b.headline}`);
  for (const i of b.items) console.log(`  ${i.label}：${i.text}`);
  console.log(`  建议：${b.suggestion}`);
  console.log(`  （已入库 #${b.id}，source=ledger）`);
}
