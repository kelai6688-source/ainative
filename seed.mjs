// seed.mjs —— 灌一份和视频里同构的示例数据（示例数据，不是真实店铺）
import { db, nowIso, today } from "./db.mjs";

const RESET = process.argv.includes("--reset");
const D = (offset) => {
  const t = new Date(today() + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + offset);
  return t.toISOString().slice(0, 10);
};

if (RESET) {
  for (const t of ["card_log", "cards", "decisions", "criteria", "briefs", "agents",
                   "reports", "patrols", "kb_entries"]) {
    db.exec(`DELETE FROM ${t};`);
  }
  db.exec("DELETE FROM sqlite_sequence;");
}

const T = nowIso();

// ---- Agents：谁负责，能定到哪一级，几点干活，主指标是什么 ----
const T0 = "2026-11-16T00:05:00.000Z";
const agents = [
  // id, name, mandate, scope, alive, last_run_at, next_run_at, shift, metric_label, metric_value, metric_extra
  ["S", "我", "定方向、点头、花钱。不上手干活。", "P0", 1, null, null, null, "等你拍板", "3 件", "今天"],
  ["ceo", "CEO Agent", "汇总、派活、验收、催办。中事自己定。", "P1", 1, T0, null,
    [{ at: "每小时", do: "巡一遍各房间：数据有没有按时到、事项有没有卡住" },
     { at: "08:20", do: "收 6 个 Agent 的汇报，合成一份给我" },
     { at: "21:30", do: "催还没交活的，把明天的活排出去" }],
    "在验收", "4 件", "每小时巡视"],
  ["shop", "电商 Agent", "上品、改文案、看数、对账。自己项目里怎么做它定。", "P2", 1, T0,
    "2026-11-16T10:30:00+08:00",
    [{ at: "08:05", do: "拉四路数据（订单/流量/品牌分析/Printful）" },
     { at: "10:30", do: "对账：子体挂齐没、有没有卡单" },
     { at: "21:00", do: "出当天成本与利润" }],
    "本周销售", "$309", "4 个店"],
  ["content", "内容 Agent", "跟各平台数据、给选题。发不发我定。", "P2", 1, T0,
    "2026-11-16T12:00:00+08:00",
    [{ at: "08:16", do: "采抖音大号/小号、公众号、X 的数据" },
     { at: "12:00", do: "给 3 个选题，附上周同类数据" }],
    "本周新增触达", "+1.46 万", "5 个平台"],
  ["oss", "开源 Agent", "分诊 issue/PR。P2 的自己修，定不了的报 CEO。", "P2", 1,
    "2026-11-16T07:00:00+08:00", "2026-11-16T11:00:00+08:00",
    [{ at: "07:00", do: "扫 issue / PR，按 P0-P2 分级" },
     { at: "11:00", do: "把 P2 的修掉，P0/P1 写成决策包" }],
    "本周新增星", "+47", "12 个仓库 · 2 issue · 3 PR"],
  ["inv", "投资 Agent", "两套系统跑数据，每天汇报。不动钱。", "P2", 1,
    "2026-11-16T05:44:00+08:00", null,
    [{ at: "05:44", do: "出美股量化 + 产业投资的日报" }],
    "模块在跑", "2/2", "日报 05:44"],
  ["kb", "运营·知识库 Agent", "每晚把各部门做完的事落成条目。", "P2", 1,
    "2026-11-15T22:30:00+08:00", "2026-11-16T22:30:00+08:00",
    [{ at: "22:30", do: "去每个部门看今天做完什么，落进知识库" }],
    "知识条目", "0 条", "每晚沉淀"],
  ["tc", "千川投流 Agent", "盯千川全域推广：消耗/ROI/成本，判断放量·控成本·关停；花钱的事只出建议+决策包。", "P1", 1, null, null, null, "千川在投", "—", "还没采过"],
];
const insAgent = db.prepare(`INSERT INTO agents
  (id,name,mandate,scope,alive,last_run_at,next_run_at,shift_json,metric_label,metric_value,metric_extra)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
for (const [id, name, mandate, scope, alive, last, next, shift, ml, mv, me] of agents) {
  insAgent.run(id, name, mandate, scope, alive, last, next,
    shift ? JSON.stringify(shift) : null, ml, mv, me);
}

// ---- Agent 汇报（今天的） ----
const insRep = db.prepare("INSERT INTO reports (agent_id,day,summary,payload_json,created_at) VALUES (?,?,?,?,?)");
insRep.run("shop", today(),
  "4 个店数据都到了。Etsy 店铺 B 昨天浏览量 2121、在售 356、评分 4.6；亚马逊 $69.98。1 件卡单已催 Printful。",
  JSON.stringify({ amazon: 69.98, etsy: 238.89, shopify: 0, orders: 11 }), T0);
insRep.run("content", today(),
  "抖音大号 6.40 万播放（+1.39 万），小号 2.25 万；公众号 +53。3 个选题已给 CEO，等拍板。",
  JSON.stringify({ dy_big: 64000, dy_small: 22500, topics: 3 }), T0);
insRep.run("oss", today(),
  "本周 +47 星，上周全周 +15。待处理 2 issue · 3 PR；P2 的 2 个自己修完了，剩下 1 个 PR 要你定要不要合。",
  JSON.stringify({ stars: 20569, week_new: 47, issues: 2, prs: 3 }), T0);
insRep.run("inv", today(), "美股量化 +0.25%（本周），产业投资 2/2 模块在跑，昨天刚把增量化做出来。", null, T0);
insRep.run("asst", today(), "论坛 2 个（AI 论坛 11 今天）、黑客松 1 个快截止、职位扫描 5 条新。已排进日程。", null, T0);

// ---- CEO 巡视轮次（今天 8 轮，出手 4 次） ----
const insPatrol = db.prepare("INSERT INTO patrols (at,round_no,actions_json,created_at) VALUES (?,?,?,?)");
const rounds = [
  [1, []],
  [2, [{ kind: "催办", card_id: 7, note: "早报模板 3 天没动" }]],
  [3, []],
  [4, [{ kind: "上报", card_id: 6, note: "卡住：早报从 6 行压到 4 行" }]],
  [5, []],
  [6, [{ kind: "待你验收", card_id: 1, note: "给一款 T 恤的标题补上买家在搜的词" }]],
  [7, [{ kind: "上报", card_id: 4, note: "P0 欠决策：3 款主力 T 恤降价 8%" }]],
  [8, []],
];
for (const [n, acts] of rounds) {
  const hh = String(5 + n).padStart(2, "0");
  const mm = String((n * 7) % 60).padStart(2, "0");
  insPatrol.run(`2026-11-16T${hh}:${mm}:00+08:00`, n, JSON.stringify(acts), T0);
}

// ---- 知识沉淀（昨晚落的） ----
const insKb = db.prepare("INSERT INTO kb_entries (dept,title,body,source_card_id,created_at) VALUES (?,?,?,?,?)");
insKb.run("shop", "查商标环节怎么过",
  "做了什么：3 张疑似撞车的设计逐一检索截图。\n怎么算完成：3 张都给出「可用/不可用/需律师看」三选一。\n为什么做：查商标环节卡了 3 张。\n范围：未走决策包（P1 以下）。",
  5, "2026-11-15T22:30:00+08:00");
insKb.run("ceo", "早报为什么要压到 4 行",
  "结论：第二屏没人看。\n判据：连续 3 天早报都在 4 行内，且「一处要看」那行必须给出可执行建议。\n代价：少报几条不痛不痒的。",
  null, "2026-11-15T22:30:00+08:00");

// ---- 决策包 / 决定库 ----
const insDec = db.prepare(`INSERT INTO decisions
 (question,recommendation,cost,scope,silent_default,answer,condition,asked_by,card_id,created_at,decided_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

insDec.run(
  "要不要开第 2 批 30 张设计",
  "开。第 1 批 30 张有 11 张来人，落在「中间」档，方向没被否；再等 7 天窗口太长，先并行开一批不冲突的品类。",
  "设计与出图成本约 30 张 × $0.6；占用我 20 分钟做「哪几张不上」的闸门。",
  "只开 30 张，不改价格、不动现有 listing。",
  "不回 = 不开，不花钱。",
  "agree", null, "ceo", null, D(-2) + "T09:00:00.000Z", D(-2) + "T10:12:00.000Z"
);

insDec.run(
  "广告日预算 $8 → $15",
  "先到 $12。上一批 ACoS 掉到 18% 但曝光没吃到量，$15 会在低转化词上烧钱。",
  "每天多 $7，30 天约 $210；若 ACoS 升破 30%，一个月白烧 $100+。",
  "只对 3 个已验证词的广告组提，新词不加。",
  "不回 = 不提，维持 $8。",
  "conditional", "先提 $12，7 天后按 ACoS ≤ 25% 再决定要不要到 $15。",
  "shop", null, D(-1) + "T08:30:00.000Z", D(-1) + "T21:40:00.000Z"
);

insDec.run(
  "标题补词要不要一次性改 12 个 listing",
  "不要。一次改 12 个，出问题分不清是哪一个改坏的。先改 4 个，第 7 天看数据。",
  "慢 3 天；但省掉一次「全军覆没还要回滚」的风险。",
  "先 4 个，2 周内跑完 12 个。",
  "不回 = 一个都不改。",
  null, null, "shop", null, D(-1) + "T07:10:00.000Z", null
);

// ---- 台账卡片 ----
const insCard = db.prepare(`INSERT INTO cards
 (title,why,deliverable,done_def,level,owner,status,check_day,created_day,decision_id,verdict,created_at,updated_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

insCard.run(
  "给一款 T 恤的标题补上买家在搜的词",
  "上架两周几乎没人来看，多半是搜不到。",
  "新标题改上去，附买家页截图。",
  "买家页上显示的是新标题，且前 3 个词是品牌分析里的真实搜索词。",
  "P0", "shop", "review", 7, D(-2), 1, null, T, T
);

insCard.run(
  "批量建 30 张设计的商品（只建不发）",
  "第 1 批验证「中间」，先建后发，省一次重来。",
  "30 个父体，每个父体挂齐 衣色 × 尺码 子 ASIN；全部停在草稿。",
  "30 个父体全部建好、子体挂齐、对账表填完；状态仍是草稿，没有一个上架。",
  "P1", "shop", "doing", 2, D(-1), 1, null, T, T
);

insCard.run(
  "设计验收：这一批 30 张里哪几张不上",
  "AI 出图能跑完，但拼写错、商标撞车必须人来判。",
  "一张清单：留下 / 剔除 + 每张一句话理由。",
  "30 张全部有结论，剔除项写清原因（拼写 / 商标 / 主体不清）。",
  "P0", "shop", "todo", 1, D(0), null, null, T, T
);

insCard.run(
  "3 款主力 T 恤降价 8%",
  "两款被同价位竞品压了一周，转化率掉了 2 个点。",
  "改价后的买家页截图 + 7 天转化率对比。",
  "3 款价格都改到位；第 7 天转化率回到降前水平或以上。",
  "P0", "shop", "todo", 7, D(0), null, null, T, T
);

insCard.run(
  "排查 3 张设计的商标撞车",
  "查商标环节卡了 3 张，疑似与在册图形商标近似。",
  "3 张的检索截图 + 是否可用的结论。",
  "3 张都给出「可用 / 不可用 / 需律师看」三选一，并有检索截图。",
  "P2", "shop", "done", 1, D(-3), 2, "pass", T, T
);

insCard.run(
  "广告预算提到 $12 并盯 7 天 ACoS",
  "已按决策包批的 $12 执行，要盯到第 7 天给结论。",
  "7 天逐日 ACoS 表。",
  "7 天数据齐全；第 7 天给出「到 $15 / 维持 $12 / 回 $8」三选一结论。",
  "P1", "shop", "doing", 7, D(-1), 2, null, T, T
);

insCard.run(
  "把早报从 6 行压到 4 行",
  "早报太长，我早上不看第二屏。",
  "新版早报模板 + 3 天试跑。",
  "连续 3 天早报都在 4 行内，且「一处要看」那行必须给出可执行建议。",
  "P1", "ceo", "blocked", 3, D(-4), null, null, T, T
);

// ---- 判据 ----
const insCrit = db.prepare(`INSERT INTO criteria
 (batch,metric,read_day,rules_json,created_day,value,verdict,evaluated_at,created_at)
 VALUES (?,?,?,?,?,?,?,?,?)`);

insCrit.run(
  "第 1 批 30 张设计",
  "有人来看的有几张",
  14,
  JSON.stringify([
    { op: ">=", value: 15, result: "成" },
    { op: ">=", value: 8, result: "中间" },
    { op: "<", value: 8, result: "不成" },
  ]),
  D(-16), 11, "中间", D(-2) + "T07:00:00.000Z", T
);

insCrit.run(
  "第 2 批 30 张设计",
  "有人来看的有几张",
  14,
  JSON.stringify([
    { op: ">=", value: 15, result: "成" },
    { op: ">=", value: 8, result: "中间" },
    { op: "<", value: 8, result: "不成" },
  ]),
  D(-15), null, null, null, T
);

// ---- 早报（platform 版：这三行要接 SP-API + Printful 才有，示例里是占位）----
db.prepare(
  "INSERT INTO briefs (day,headline,items_json,suggestion,source,created_at) VALUES (?,?,?,?,?,?)"
).run(
  today(),
  "一处要看，其余正常",
  JSON.stringify([
    { label: "流量", text: "整体和上周差不多（-3%）", tone: "ok" },
    { label: "订单", text: "昨天的单，都已进 Printful 生产", tone: "ok" },
    { label: "评论", text: "没有新的差评", tone: "ok" },
    { label: "异常", text: "一款 T 恤：上架两周，几乎没人来看", tone: "warn" },
  ]),
  "建议标题补上买家在搜的词，因为几乎没人来，多半是搜不到。已在台账开卡，等你在「哪几张不上」那一步点头。",
  "platform",
  T
);

console.log("seed ok →", today());
console.log("  cards:", db.prepare("SELECT COUNT(*) c FROM cards").get().c);
console.log("  decisions:", db.prepare("SELECT COUNT(*) c FROM decisions").get().c);
console.log("  criteria:", db.prepare("SELECT COUNT(*) c FROM criteria").get().c);
