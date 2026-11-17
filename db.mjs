// db.mjs —— 零依赖，用 Node 内置 node:sqlite
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const ROOT = import.meta.dirname;
export const DB_PATH = process.env.AINATIVE_DB || path.join(ROOT, "ainative.db");

if (process.env.AINATIVE_DB && fs.existsSync(DB_PATH) === false) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mandate     TEXT NOT NULL,          -- 这个 Agent 管什么
  scope       TEXT NOT NULL           -- P0 / P1 / P2 / P3
);

-- 台账：一件事一张卡
CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,          -- 这件事
  why         TEXT NOT NULL,          -- 为什么做
  deliverable TEXT NOT NULL,          -- 要交什么
  done_def    TEXT NOT NULL,          -- 怎么算完成（开工前写好，不可空）
  level       TEXT NOT NULL,          -- P0 大事我定 | P1 CEO定 | P2 AI定 | P3 谁做谁定
  owner       TEXT NOT NULL,          -- 负责的 Agent
  status      TEXT NOT NULL,          -- todo|doing|review|done|blocked|cancelled
  check_day   INTEGER NOT NULL,       -- 第 N 天回看
  created_day TEXT NOT NULL,          -- 创建日期 YYYY-MM-DD
  decision_id INTEGER,                -- 来源决策包
  verdict     TEXT,                   -- 验收结论 pass|fail|null
  exec_mode   TEXT DEFAULT 'assist',  -- auto 有执行器能自己跑 | assist 出方案等人批 | human 只能人做
  next_action TEXT,                   -- CEO 每轮算出来的下一步（催办/升级/等交/可自动执行/等拍板）
  next_reason TEXT,                   -- 为什么是这一步
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 台账日志：谁在什么时候做了什么
CREATE TABLE IF NOT EXISTS card_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  note     TEXT
);

-- 决策包 + 决定库（同一个表：answer 为空=待我定，非空=已进决定库）
CREATE TABLE IF NOT EXISTS decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  question       TEXT NOT NULL,       -- ① 要定什么
  recommendation TEXT NOT NULL,       -- ② 它建议什么
  cost           TEXT NOT NULL,       -- ③ 代价是什么
  scope          TEXT NOT NULL,       -- ④ 批的范围多大
  silent_default TEXT NOT NULL,       -- ⑤ 我不回会怎样
  answer         TEXT,                -- agree|conditional|reject|defer|null
  condition      TEXT,                -- 附条件
  asked_by       TEXT NOT NULL,       -- 谁提的
  card_id        INTEGER,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);

-- 判据：上架前先写标准，到点按标准读
CREATE TABLE IF NOT EXISTS criteria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch       TEXT NOT NULL,          -- 这一批 30 张设计
  metric      TEXT NOT NULL,          -- 第 14 天看：有人来看的有几张
  read_day    INTEGER NOT NULL,       -- 第 14 天
  rules_json  TEXT NOT NULL,          -- [{"op":">=","value":15,"result":"成"}, ...]
  created_day TEXT NOT NULL,
  value       REAL,                   -- 到点读出来的数
  verdict     TEXT,                   -- 成|中间|不成
  evaluated_at TEXT,
  created_at  TEXT NOT NULL
);

-- 早报
CREATE TABLE IF NOT EXISTS briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,
  headline   TEXT NOT NULL,           -- 一处要看，其余正常
  items_json TEXT NOT NULL,           -- [{label,text,tone}]
  suggestion TEXT,
  source     TEXT NOT NULL DEFAULT 'platform',  -- platform(数据底座) | ledger(台账规则生成)
  created_at TEXT NOT NULL
);

-- Agent 汇报：每个业务 Agent 定时往 CEO 桌上放一条
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  day          TEXT NOT NULL,
  summary      TEXT NOT NULL,          -- 一句话：我今天干了什么、卡在哪
  payload_json TEXT,                   -- 想带上来的数字，随便什么结构
  created_at   TEXT NOT NULL
);

-- CEO 巡视轮次：每一轮记一条，出手动作也记
CREATE TABLE IF NOT EXISTS patrols (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  round_no     INTEGER NOT NULL,
  actions_json TEXT NOT NULL,          -- [{kind,card_id,note}]
  created_at   TEXT NOT NULL
);

-- 知识沉淀：每晚把「做完的事」落成条目
CREATE TABLE IF NOT EXISTS kb_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dept           TEXT NOT NULL,        -- 哪个部门 / 哪个 Agent
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,        -- 结论 + 判据 + 代价，不是流水账
  source_card_id INTEGER,
  created_at     TEXT NOT NULL
);

-- 子指标：一个 Agent 底下挂的每个数据源各存一行（总览第二层那排卡片）
CREATE TABLE IF NOT EXISTS submetrics (
  agent_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  label      TEXT,
  value      TEXT,
  extra      TEXT,
  ok         INTEGER NOT NULL DEFAULT 1,
  at         TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);

-- 多窗口快照：同一家店，实时的数 / 近7天的数 / 近30天的数各存一份，互不覆盖
CREATE TABLE IF NOT EXISTS metric_snapshots (
  agent_id  TEXT NOT NULL,
  win       TEXT NOT NULL,            -- 实时 / 近7天 / 近30天
  key       TEXT NOT NULL,
  label     TEXT,
  value     TEXT,
  extra     TEXT,
  ok        INTEGER DEFAULT 1,
  at        TEXT NOT NULL,
  PRIMARY KEY (agent_id, win, key)
);
CREATE INDEX IF NOT EXISTS idx_snap_agent ON metric_snapshots(agent_id, win);

-- 授权矩阵：同一类任务只问一次，之后按这里的选择自动走
--   mode: auto = CEO/AI 全权处理（只在台账留痕）
--         human = 每次都交人
--         ask   = 每次问（默认，等于没定）
CREATE TABLE IF NOT EXISTS task_policies (
  category   TEXT PRIMARY KEY,      -- 任务类别（改标题 / 停投 / 售后 / 参数 / 链接合并 …）
  mode       TEXT NOT NULL,         -- auto | human | ask
  decided_by TEXT,                  -- 谁定的
  note       TEXT,                  -- 当时怎么说的
  decided_at TEXT
);

-- 市场采集：精选联盟爆款榜 / 电商罗盘选品，两边都落这张表
CREATE TABLE IF NOT EXISTS market_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,     -- 精选联盟·爆款榜 | 抖店·电商罗盘
  category        TEXT,
  rank_window     TEXT,              -- 近2小时 | 近7天 | 默认榜
  title           TEXT NOT NULL,
  price           REAL,
  sales_2h        REAL,
  commission_rate REAL,
  shop            TEXT,
  item_id         TEXT,
  raw             TEXT,
  fetched_at      TEXT NOT NULL,
  UNIQUE(source, item_id, title)
);

-- 选品流水线：候选 → CEO审核 → 等你确认 → 做素材 → 草稿箱 → 等货源成本 → 上架 → 投流
CREATE TABLE IF NOT EXISTS product_pipeline (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop         TEXT NOT NULL,
  stage        TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT,
  spec_idea    TEXT,
  price_idea   REAL,
  cost_idea    REAL,
  evidence     TEXT,
  score        REAL,
  ceo_verdict  TEXT,
  ceo_reason   TEXT,
  owner_answer TEXT,
  owner_note   TEXT,
  item_id      TEXT,
  copy_file    TEXT,
  images_json  TEXT,
  sku_json     TEXT,
  cost_json    TEXT,
  ad_json      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 结算账单：抖店「资金-账单管理-结算账单」逐笔抓下来
-- 这是费率的唯一可信来源（备注列直接写「平台服务费率2%;商品类目: …」）
CREATE TABLE IF NOT EXISTS settlements (
  shop          TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  settle_at     TEXT,
  order_at      TEXT,
  item_id       TEXT,
  paid          REAL,      -- 用户实付
  subsidy       REAL,      -- 平台补贴
  base          REAL,      -- 计费合计（实付+补贴）
  service_fee   REAL,      -- 平台服务费（负数）
  fee_rate      REAL,      -- 费率（0.02 = 2%）
  settle_amount REAL,      -- 结算到账
  talent_fee    REAL,      -- 达人佣金
  category      TEXT,
  note          TEXT,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (shop, order_id)
);

-- 类目费率（从账单归纳，带样本数，比手填可信）
CREATE TABLE IF NOT EXISTS fee_rates (
  shop      TEXT NOT NULL,
  category  TEXT NOT NULL,
  rate      REAL NOT NULL,
  samples   INTEGER NOT NULL,
  source    TEXT,
  at        TEXT NOT NULL,
  PRIMARY KEY (shop, category)
);

-- SKU 清单：规格 / 售价 / 库存 / SKUID
-- 拿货成本按 SKU 记（同一商品的不同规格成本差很远：尝鲜装/家庭装/囤货装）
CREATE TABLE IF NOT EXISTS skus (
  shop        TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  spec        TEXT NOT NULL,
  sku_id      TEXT,
  price       REAL,
  stock       INTEGER,
  status      TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (shop, item_id, spec)
);
CREATE INDEX IF NOT EXISTS idx_skus_item ON skus(shop, item_id);

-- 商品清单：商品ID（链接里那个）+ 标题 + 价格 + 库存 + 状态
-- 拿货成本按商品ID记，不按名字模糊匹配
CREATE TABLE IF NOT EXISTS products (
  shop        TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  title       TEXT,
  price_min   REAL,
  price_max   REAL,
  stock       INTEGER,
  status      TEXT,
  raw_json    TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (shop, item_id)
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop);

-- 订单明细：从后台页面/CSV 抓下来的逐单数据，电商分析的底座
CREATE TABLE IF NOT EXISTS orders (
  shop        TEXT NOT NULL,          -- 哪家店（agent id）
  order_id    TEXT NOT NULL,
  sku         TEXT,
  qty         INTEGER,
  amount      REAL,
  status      TEXT,
  created_at  TEXT,
  raw_json    TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (shop, order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_shop_status ON orders(shop, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- 执行审计：凡是真往平台上发过的写操作，都留一行（dry-run 也留）
CREATE TABLE IF NOT EXISTS executions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT NOT NULL,
  target       TEXT,
  params_json  TEXT NOT NULL,
  decision_id  INTEGER,
  dry_run      INTEGER NOT NULL DEFAULT 1,
  ok           INTEGER,
  idem_key     TEXT,
  request_path TEXT,
  response     TEXT,
  error        TEXT,
  requested_by TEXT,
  at           TEXT NOT NULL
);
-- 幂等：只对「真发成功」的那一次去重；失败和 dry-run 可以重复记录（要留证据）
DROP INDEX IF EXISTS idx_exec_idem;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_idem ON executions(idem_key) WHERE dry_run = 0 AND ok = 1;
`);

// 轻量迁移：老库补列
function addColumnIfMissing(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
}
addColumnIfMissing("orders", "income", "income REAL");
addColumnIfMissing("orders", "item_id", "item_id TEXT");
// 注意：tc_materials 的补列必须放在下面那张 CREATE TABLE 之后，否则新库会炸「no such table」

// ── 千川投流（2026-11-17）：计划快照 + 建议 ──────────────────────
// tc_ads 每次采集覆盖写（一个计划一行，保留最新）；
// tc_advice 是「建议流水」，同一条建议不重复开（按 ad_id+action+日期 去重）。
db.exec(`
CREATE TABLE IF NOT EXISTS tc_ads (
  ad_id        TEXT PRIMARY KEY,
  name         TEXT,
  status       TEXT,          -- 投放中 / 已暂停 / 已删除 …
  budget       REAL,          -- 日预算（元）
  roi_goal     REAL,          -- 目标 ROI（ecpRoi2Goal）
  mar_goal     INTEGER,
  adlab_mode   INTEGER,
  learning     INTEGER,       -- 学习期标记
  cost         REAL,          -- 消耗（元）
  gmv          REAL,          -- 成交金额（元）
  orders       INTEGER,
  cost_per_order REAL,
  roi          REAL,          -- gmv / cost
  raw          TEXT,
  at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tc_advice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id       TEXT NOT NULL,
  ad_name     TEXT,
  action      TEXT NOT NULL,   -- 放量 / 控成本 / 关停 / 换素材 / 继续观察
  level       TEXT NOT NULL,   -- P0 / P1 / P2
  reason      TEXT,
  numbers     TEXT,            -- 当次判断依据（JSON）
  decision_id INTEGER,
  status      TEXT DEFAULT 'open',   -- open / decided / done / dropped
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_advice ON tc_advice(ad_id, action, at);
CREATE TABLE IF NOT EXISTS tc_materials (
  item_id     TEXT PRIMARY KEY,
  title       TEXT,
  duration    REAL,
  audit       INTEGER,     -- 1 通过 / 其他 不通过
  delivery    INTEGER,     -- 投放状态码
  low_eff     INTEGER,     -- 低效素材
  high_q      INTEGER,     -- 优质素材
  improvable  INTEGER,
  cost        REAL,        -- 素材级消耗（元）
  roi         REAL,        -- 素材级支付ROI
  ctr         REAL,
  cvr         REAL,
  stats       TEXT,        -- materialStatsData 原样（有就存）
  raw         TEXT,
  at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tc_snapshot (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  balance   REAL,
  budget    REAL,
  cost_today REAL,
  gmv_today  REAL,
  roi_today  REAL,
  orders_today INTEGER,
  plans     INTEGER,
  payload   TEXT
);
`);

// 千川素材的补列（必须在这张表建出来之后跑，否则新库会报 no such table）
for (const [col, ddl] of [["cost", "cost REAL"], ["roi", "roi REAL"], ["ctr", "ctr REAL"], ["cvr", "cvr REAL"]]) {
  addColumnIfMissing("tc_materials", col, ddl);
}

addColumnIfMissing("briefs", "source", "source TEXT NOT NULL DEFAULT 'platform'");

// Agent 的在岗 / 排班 / 主指标（对齐第二支视频里的 Agent 卡）
for (const [col, ddl] of [
  ["alive", "alive INTEGER NOT NULL DEFAULT 1"],
  ["last_run_at", "last_run_at TEXT"],
  ["next_run_at", "next_run_at TEXT"],
  ["shift_json", "shift_json TEXT"],
  ["metric_label", "metric_label TEXT"],
  ["metric_value", "metric_value TEXT"],
  ["metric_extra", "metric_extra TEXT"],
]) addColumnIfMissing("agents", col, ddl);

db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_status   ON cards(status);
         CREATE INDEX IF NOT EXISTS idx_cards_decision ON cards(decision_id);
         CREATE INDEX IF NOT EXISTS idx_cards_owner    ON cards(owner);
         CREATE INDEX IF NOT EXISTS idx_dec_answer     ON decisions(answer);
         CREATE INDEX IF NOT EXISTS idx_reports_agent  ON reports(agent_id);
         CREATE INDEX IF NOT EXISTS idx_kb_dept        ON kb_entries(dept);`);

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export const STATUS_LABEL = {
  todo: "待办",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
  blocked: "卡住",
  cancelled: "已取消",
};

export const LEVEL_LABEL = {
  P0: "大事·我定",
  P1: "中事·CEO定",
  P2: "小事·AI定",
  P3: "更小·谁做谁定",
};

export const ANSWER_LABEL = {
  agree: "同意",
  conditional: "附条件同意",
  reject: "不同意",
  defer: "另定",
};

/** 把 rules_json 按顺序套到 value 上，返回第一个命中的 result */
export function applyRules(rules, value) {
  for (const r of rules) {
    const v = Number(value);
    const t = Number(r.value);
    let hit = false;
    switch (r.op) {
      case ">=": hit = v >= t; break;
      case ">":  hit = v > t; break;
      case "<=": hit = v <= t; break;
      case "<":  hit = v < t; break;
      case "==": hit = v === t; break;
      default:   hit = false;
    }
    if (hit) return r.result;
  }
  return rules.at(-1)?.result ?? null;
}

/** 天数差 */
export function dayGap(fromDay, toDay = today()) {
  const a = new Date(fromDay + "T00:00:00Z").getTime();
  const b = new Date(toDay + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function logCard(cardId, actor, action, note = null) {
  db.prepare(
    "INSERT INTO card_log (card_id, at, actor, action, note) VALUES (?,?,?,?,?)"
  ).run(cardId, nowIso(), actor, action, note);
}

/**
 * P0 闸门用：这张卡有没有一张「我批过」的决策包？
 * 只认 agree / conditional，不认 reject / defer，更不认「没人回」。
 * 两个方向都认：cards.decision_id → decisions.id，以及 decisions.card_id → cards.id。
 */
export function approvedDecisionFor(cardId) {
  const c = db.prepare("SELECT decision_id FROM cards WHERE id = ?").get(cardId);
  if (!c) return null;
  const row = db
    .prepare(
      `SELECT * FROM decisions
        WHERE answer IN ('agree','conditional')
          AND (id = ? OR card_id = ?)
        ORDER BY id DESC LIMIT 1`
    )
    .get(c.decision_id ?? -1, cardId);
  return row || null;
}

/** 决定库检索：提建议前先翻以前怎么定的 */
export function searchDecisions(q) {
  const like = `%${q}%`;
  return db
    .prepare(
      `SELECT * FROM decisions
        WHERE answer IS NOT NULL
          AND (question LIKE ? OR recommendation LIKE ? OR scope LIKE ? OR IFNULL(condition,'') LIKE ?)
        ORDER BY id DESC LIMIT 50`
    )
    .all(like, like, like, like);
}

