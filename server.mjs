// server.mjs —— 零依赖 HTTP + JSON API + 静态页
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  db, nowIso, today, dayGap, applyRules, logCard, approvedDecisionFor, searchDecisions,
  STATUS_LABEL, LEVEL_LABEL, ANSWER_LABEL,
} from "./db.mjs";
import { generateBrief } from "./brief.mjs";

const PORT = Number(process.env.PORT || 8788);
const PUBLIC = path.join(import.meta.dirname, "public");
const PROFILE_PATH = path.join(import.meta.dirname, "profile.json");
const SHOPS_PATH = path.join(import.meta.dirname, "shops.json");
const CONNECTORS_PATH = path.join(import.meta.dirname, "connectors.json");

// 平台 → 官方连接器模块 / 默认指标（开新店时选平台就够）
const PLATFORMS = {
  "douyin-shop": { name: "抖店", module: "douyin-shop", metric: "待发货订单", envs: ["DOUYIN_SHOP_APP_KEY", "DOUYIN_SHOP_APP_SECRET", "DOUYIN_SHOP_ACCESS_TOKEN"] },
  pdd: { name: "拼多多", module: "pdd", metric: "待发货订单", envs: ["PDD_CLIENT_ID", "PDD_CLIENT_SECRET"] },
  taobao: { name: "淘宝/天猫", module: "taobao", metric: "待发货", envs: ["TAOBAO_APP_KEY", "TAOBAO_APP_SECRET", "TAOBAO_SESSION"] },
  amazon: { name: "亚马逊", module: "amazon-sp", metric: "本周销售", envs: ["SPAPI_REFRESH_TOKEN", "SPAPI_CLIENT_ID", "SPAPI_CLIENT_SECRET"] },
  printful: { name: "Printful", module: "printful", metric: "每单成本", envs: ["PRINTFUL_API_KEY"] },
  etsy: { name: "Etsy", module: "http-json", metric: "本周销售", envs: [] },
  shopify: { name: "Shopify", module: "http-json", metric: "本周销售", envs: [] },
  csv: { name: "本地报表（CSV）", module: "csv", metric: "本周销售", envs: [] },
  other: { name: "其他", module: "csv", metric: "本周销售", envs: [] },
};

function readJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}
const readShops = () => readJSON(SHOPS_PATH, []);
const readConnectors = () => readJSON(CONNECTORS_PATH, { connectors: [] });
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "shop";

function uniqueAgentId(want, shops, conns) {
  const taken = new Set([...shops.map((s) => s.agent), ...conns.connectors.map((c) => c.agent), "S", "ceo"]);
  if (!taken.has(want)) return want;
  for (let i = 2; i < 100; i++) if (!taken.has(want + i)) return want + i;
  throw new Error("agent id 用完了");
}

const DEFAULT_PROFILE = {
  org: { name: "AI Native 内核", logo: "AI" },
  owner: { name: "我", initial: "S", role: "创始人 · 拍板定方向" },
  business: { media: [], shops: [] },
};

function readProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
    return { ...DEFAULT_PROFILE, ...p, org: { ...DEFAULT_PROFILE.org, ...(p.org || {}) }, owner: { ...DEFAULT_PROFILE.owner, ...(p.owner || {}) } };
  } catch {
    return DEFAULT_PROFILE;
  }
}
function writeProfile(p) {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2) + "\n", "utf8");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const Q = {
  cards: db.prepare("SELECT * FROM cards ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'review' THEN 1 WHEN 'doing' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, id DESC"),
  card: db.prepare("SELECT * FROM cards WHERE id = ?"),
  logs: db.prepare("SELECT * FROM card_log WHERE card_id = ? ORDER BY id DESC"),
  decisions: db.prepare("SELECT * FROM decisions ORDER BY (answer IS NOT NULL), id DESC"),
  decision: db.prepare("SELECT * FROM decisions WHERE id = ?"),
  criteria: db.prepare("SELECT * FROM criteria ORDER BY (verdict IS NOT NULL), id DESC"),
  criterion: db.prepare("SELECT * FROM criteria WHERE id = ?"),
  brief: db.prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT 1"),
  agents: db.prepare("SELECT * FROM agents ORDER BY rowid"),
  agent: db.prepare("SELECT * FROM agents WHERE id = ?"),
  reports: db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?"),
  reportsBy: db.prepare("SELECT * FROM reports WHERE agent_id = ? ORDER BY id DESC LIMIT ?"),
  kb: db.prepare("SELECT * FROM kb_entries ORDER BY id DESC LIMIT ?"),
  kbByDept: db.prepare("SELECT * FROM kb_entries WHERE dept = ? ORDER BY id DESC LIMIT ?"),
  kbCount: db.prepare("SELECT COUNT(*) c FROM kb_entries"),
  patrols: db.prepare("SELECT * FROM patrols ORDER BY id DESC LIMIT ?"),
  allLogs: db.prepare("SELECT * FROM card_log ORDER BY id DESC LIMIT ?"),
  allReports: db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?"),
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
};
const fail = (res, code, msg) => json(res, code, { ok: false, error: msg });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("body 不是合法 JSON"); }
}

// ---------- CEO 巡检：到期没动的催，卡住的报 ----------
function sweep() {
  const cards = Q.cards.all();
  const out = { overdue: [], stuck: [], due_criteria: [], silent_decisions: [], unverified: [], need_decision: [] };

  for (const c of cards) {
    if (["done", "cancelled"].includes(c.status)) continue;
    const gap = dayGap(c.created_day);
    if (gap >= c.check_day) {
      out.overdue.push({ id: c.id, title: c.title, owner: c.owner, check_day: c.check_day, gap });
    }
    if (c.status === "blocked") out.stuck.push({ id: c.id, title: c.title, owner: c.owner });
    if (c.status === "review") out.unverified.push({ id: c.id, title: c.title, owner: c.owner });
    // P0 大事卡在等我批：没决策包它一步也动不了
    if (c.level === "P0" && c.status === "todo" && !approvedDecisionFor(c.id)) {
      out.need_decision.push({ id: c.id, title: c.title, owner: c.owner });
    }
  }
  for (const k of Q.criteria.all()) {
    if (k.verdict == null && dayGap(k.created_day) >= k.read_day) {
      out.due_criteria.push({ id: k.id, batch: k.batch, metric: k.metric, read_day: k.read_day });
    }
  }
  for (const d of Q.decisions.all()) {
    if (d.answer == null && dayGap(d.created_at.slice(0, 10)) >= 1) {
      out.silent_decisions.push({ id: d.id, question: d.question, silent_default: d.silent_default });
    }
  }
  return out;
}

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
};

// 任何一次成功的写操作，都把新状态推给所有开着页面的浏览器（SSE）
let broadcastSoon = null;
function kickBroadcast() {
  if (typeof broadcastState !== "function") return;
  clearTimeout(broadcastSoon);
  broadcastSoon = setTimeout(() => { try { broadcastState(); } catch {} }, 120);
}

// 今天已经跑了几轮巡视 / 出手几次
function patrolStats() {
  const d = today();
  const rows = Q.patrols.all(500).filter((p) => p.at.slice(0, 10) === d);
  const actions = rows.reduce((n, p) => n + (JSON.parse(p.actions_json) || []).length, 0);
  return {
    today_rounds: rows.length,
    today_actions: actions,
    last_at: rows[0] ? rows[0].at : null,
    last_actions: rows[0] ? JSON.parse(rows[0].actions_json) : [],
  };
}

function state() {
  const brief = Q.brief.get();
  const cards = Q.cards.all().map((c) => ({
    ...c,
    // P0 卡：有没有一张我批过的决策包；没有就是「欠一个决策」
    gate: c.level === "P0" ? (approvedDecisionFor(c.id) ? "ok" : "need_decision") : "ok",
  }));
  const agents = Q.agents.all().map((a) => {
    const row = {
      ...a,
      shift: a.shift_json ? JSON.parse(a.shift_json) : [],
      cards_open: cards.filter((c) => c.owner === a.id && !["done", "cancelled"].includes(c.status)).length,
      last_report: db.prepare("SELECT * FROM reports WHERE agent_id = ? ORDER BY id DESC LIMIT 1").get(a.id) || null,
    };

    // 自动选品 Agent：每个采集源各采了多少、什么时候采的、头一条是什么，前端按这个渲染子行
    if (a.id === "pick") {
      const bySrc = db.prepare(
        `SELECT source, COUNT(*) total_n, MAX(fetched_at) at,
                SUM(CASE WHEN sales_2h IS NOT NULL THEN 1 ELSE 0 END) with_hot
         FROM market_items GROUP BY source ORDER BY MAX(fetched_at) DESC`
      ).all();
      const qLatest = db.prepare(
        `SELECT COUNT(*) n, SUM(CASE WHEN sales_2h IS NOT NULL THEN 1 ELSE 0 END) with_hot
         FROM market_items
         WHERE source = ? AND fetched_at = (SELECT MAX(fetched_at) FROM market_items WHERE source = ?)`
      );
      const qTop = db.prepare(
        "SELECT title, price, sales_2h, commission_rate, shop, raw FROM market_items WHERE source = ? ORDER BY COALESCE(sales_2h,0) DESC, id DESC LIMIT 1"
      );
      const qNewestRaw = db.prepare("SELECT raw FROM market_items WHERE source = ? ORDER BY id DESC LIMIT 1");
      const sources = bySrc.map((s) => {
        let top = null, boardTotal = null;
        try {
          const r0 = qTop.get(s.source);
          if (r0) {
            top = {
              title: r0.title, price: r0.price, sales_2h: r0.sales_2h,
              commission: r0.commission_rate, shop: r0.shop,
            };
          }
          // board_total 只写在最新一批里（老快照没有），所以从最新一行取，不从 top 取
          const rn = qNewestRaw.get(s.source);
          if (rn) boardTotal = JSON.parse(rn.raw || "{}").board_total ?? null;
        } catch {}
        const latest = qLatest.get(s.source, s.source) || {};
        return {
          source: s.source,
          n: latest.n || s.total_n,
          total_n: s.total_n,
          at: s.at,
          with_hot: latest.with_hot ?? 0,   // 只算「本批」里有热销值的，别拿累计数冒充
          board_total: boardTotal,
          top,
        };
      });
      const cand = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage != 'rejected'").get().n;
      const waitMe = db.prepare("SELECT COUNT(*) n FROM product_pipeline WHERE stage = 'owner_confirm'").get().n;
      const totalRows = sources.reduce((x, s) => x + s.n, 0);
      row.market = { sources, candidates: cand, waiting: waitMe, total: totalRows };
      row.metric_value = `${cand} 条`;
      row.metric_label = "候选品";
      row.metric_extra = waitMe ? `${waitMe} 条等你确认` : `市场样本 ${totalRows} 条 · ${sources.length} 个源`;
    }

    // 电商 Agent 的卡片数字必须跟「店铺快照」同一个来源，否则会出现
    // 卡片写 19.80、店铺行写 10 这种情况（一个来自分析时的旧值，一个来自刚抓的快照）。
    if (a.id === "shop") {
      const sh = readShops()[0];
      if (sh) {
        const win = sh.window || "实时";
        const snap = db.prepare(
          "SELECT key,label,value,at FROM metric_snapshots WHERE agent_id = ? AND win = ?"
        ).all(sh.agent, win);
        const gmv = snap.find((x) => x.label === "成交金额" || x.label === "用户支付金额");
        if (gmv && gmv.value != null) {
          row.metric_label = `${win}成交`;
          row.metric_value = String(gmv.value);
          row.metric_extra = `快照 ${String(gmv.at).slice(11, 16)} · ${snap.length} 项指标`;
          row.metric_at = gmv.at;
        }
      }
    }
    return row;
  });
  return {
    today: today(),
    agents,
    cards,
    decisions: Q.decisions.all(),
    criteria: Q.criteria.all(),
    brief: brief ? { ...brief, items: JSON.parse(brief.items_json) } : null,
    sweep: sweep(),
    patrol: patrolStats(),
    reports: Q.reports.all(20),
    kb_count: Q.kbCount.get().c,
    // 千川：有几条 P0 建议还没拍板（给「投流」tab 挂红点）
    tc_hot: db.prepare("SELECT COUNT(*) c FROM tc_advice WHERE level='P0' AND status='open'").get().c,
    submetrics: db.prepare("SELECT * FROM submetrics ORDER BY agent_id, key").all(),
    labels: { status: STATUS_LABEL, level: LEVEL_LABEL, answer: ANSWER_LABEL },
  };
}

route("GET", "/api/state", (req, res) => json(res, 200, state()));

// ── 实时推送：SSE ────────────────────────────────────────────────
// 抖店/拼多多这些平台没有能推到你本机的回调，所以「实时」= 秒级轮询 + 这里推给浏览器。
// 浏览器连上后：先收一份全量，然后任何一个写操作/数据刷新都会立刻推一次。
const sseClients = new Set();

function sseSend(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastState() {
  if (!sseClients.size) return;
  let snap;
  try { snap = state(); } catch { return; }
  for (const c of sseClients) {
    try { sseSend(c, "state", { at: nowIso(), state: snap }); } catch { sseClients.delete(c); }
  }
}

route("GET", "/api/stream", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  sseClients.add(res);
  sseSend(res, "state", { at: nowIso(), state: state() });

  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
  const push = setInterval(() => { try { sseSend(res, "state", { at: nowIso(), state: state() }); } catch {} }, 5000);

  req.on("close", () => {
    clearInterval(hb);
    clearInterval(push);
    sseClients.delete(res);
  });
});

// 品牌与主人：改这里，界面上的名字/头像字母/角色立刻变
route("GET", "/api/profile", (req, res) => json(res, 200, readProfile()));

route("POST", "/api/profile", async (req, res) => {
  const b = await readBody(req);
  const cur = readProfile();
  const next = {
    org: { ...cur.org, ...(b.org || {}) },
    owner: { ...cur.owner, ...(b.owner || {}) },
    business: { ...cur.business, ...(b.business || {}) },
  };
  if (next.owner.initial && String(next.owner.initial).length > 2) {
    return fail(res, 400, "头像字母最多 2 个字");
  }
  writeProfile(next);
  json(res, 200, { ok: true, profile: next });
});

// 给 Agent 改名 / 改职责（界面上那张卡和侧栏会一起变）
route("POST", "/api/agents/:id/rename", async (req, res, p) => {
  const a = Q.agent.get(p.id);
  if (!a) return fail(res, 404, "没有这个 Agent");
  const b = await readBody(req);
  if (!b.name || !String(b.name).trim()) return fail(res, 400, "缺字段：name");
  db.prepare("UPDATE agents SET name=?, mandate=COALESCE(?,mandate) WHERE id=?")
    .run(String(b.name).trim(), b.mandate ? String(b.mandate).trim() : null, a.id);
  json(res, 200, { ok: true });
});

// 新开一个 Agent：接一家新店 / 一个新号就走这里
route("POST", "/api/agents", async (req, res) => {
  const b = await readBody(req);
  const id = String(b.id || "").trim();
  if (!id || !/^[a-z][a-z0-9_-]{1,20}$/.test(id)) {
    return fail(res, 400, "缺字段：id（小写字母开头，2-21 位，只允许 a-z 0-9 _ -）");
  }
  if (!b.name || !String(b.name).trim()) return fail(res, 400, "缺字段：name");
  if (Q.agent.get(id)) return fail(res, 409, `Agent ${id} 已存在`);
  const scope = b.scope || "P2";
  if (!LEVEL_LABEL[scope]) return fail(res, 400, `级别只能是 ${Object.keys(LEVEL_LABEL).join(" / ")}`);
  db.prepare(
    "INSERT INTO agents (id,name,mandate,scope,alive,last_run_at,next_run_at,shift_json,metric_label,metric_value,metric_extra) VALUES (?,?,?,?,0,NULL,NULL,'[]',NULL,NULL,NULL)"
  ).run(id, String(b.name).trim(), String(b.mandate || "").trim() || "待定义职责", scope);
  json(res, 201, { ok: true, id });
});

// 删掉一个 Agent（有未结卡就不许删，先处理干净）
route("DELETE", "/api/agents/:id", (req, res, p) => {
  const a = Q.agent.get(p.id);
  if (!a) return fail(res, 404, "没有这个 Agent");
  if (["S", "ceo"].includes(a.id)) return fail(res, 400, "创始人和 CEO 不能删");
  const open = db.prepare("SELECT COUNT(*) c FROM cards WHERE owner=? AND status NOT IN ('done','cancelled')").get(a.id).c;
  if (open) return fail(res, 409, `它手上还有 ${open} 件没结的卡，先处理完再删`);
  db.prepare("DELETE FROM agents WHERE id=?").run(a.id);
  json(res, 200, { ok: true });
});

// 子指标：Agent 底下每个数据源各一行
route("POST", "/api/agents/:id/submetric", async (req, res, p) => {
  const a = Q.agent.get(p.id);
  if (!a) return fail(res, 404, "没有这个 Agent");
  const b = await readBody(req);
  const key = String(b.key || "").trim();
  if (!key) return fail(res, 400, "缺字段：key");
  db.prepare(
    `INSERT INTO submetrics (agent_id,key,label,value,extra,ok,at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(agent_id,key) DO UPDATE SET label=excluded.label, value=excluded.value,
       extra=excluded.extra, ok=excluded.ok, at=excluded.at`
  ).run(a.id, key, b.label || null, b.value == null ? null : String(b.value), b.extra || null, b.ok === false ? 0 : 1, nowIso());
  json(res, 200, { ok: true });
});

// ── 扫码登录：服务端帮你开一个有头浏览器，你扫码，它自己存会话 ──────
route("GET", "/api/login/status", (req, res) => {
  const base = path.join(import.meta.dirname, ".browser");
  const out = {};
  try {
    for (const site of fs.readdirSync(base)) {
      const meta = path.join(base, site, "meta.json");
      if (!fs.existsSync(meta)) continue;
      const m = JSON.parse(fs.readFileSync(meta, "utf8"));
      out[site] = { ok: !!m.ok, login_at: m.login_at, url: m.url, cookies: (m.cookies || []).length };
    }
  } catch {}
  json(res, 200, { sites: out });
});

route("POST", "/api/login/:site", async (req, res, p) => {
  const b = await readBody(req);
  const site = p.site;
  const args = [path.join(import.meta.dirname, "login.mjs"), "--site", site];
  if (b.url) args.push("--url", String(b.url));
  if (b.done_url) args.push("--done-url", String(b.done_url));
  args.push("--timeout", String(Math.min(900, Math.max(60, Number(b.timeout || 300)))));

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, args, {
    cwd: import.meta.dirname,
    detached: true,
    stdio: "ignore",
    windowsHide: false,   // 要让你看见那个浏览器窗口
  });
  child.unref();

  json(res, 202, {
    ok: true, pid: child.pid, site,
    note: "已经在你桌面上开了一个浏览器窗口，扫码登录；登录成功后会自动存会话并关窗。",
  });
});

// 连接器只读清单（不含任何凭证值），前端用来在 Agent 下面挂子项
route("GET", "/api/connectors", (req, res) => {
  const c = readConnectors();
  json(res, 200, {
    connectors: c.connectors.map((x, i) => ({
      idx: i, id: x.id, module: x.module || x.id, agent: x.agent, label: x.label || "",
      enabled: !!x.enabled, path: x.path || null, where: x.where || null,
    })),
  });
});

// ── 经营参数：按店铺各一套（类目扣点 / 物流 / 包装 / 每个 SKU 拿货成本）──
const ECOM_CFG_PATH = path.join(import.meta.dirname, "ecom.config.json");
const ECOM_DEFAULTS = { paymentFeeRate: 0.006, shippingPerOrder: 0, packagingPerOrder: 0, categoryFeeRate: 0, skus: [] };

function readEcomCfgAll() {
  try {
    const j = JSON.parse(fs.readFileSync(ECOM_CFG_PATH, "utf8"));
    return { defaults: { ...ECOM_DEFAULTS, ...(j.defaults || {}) }, shops: j.shops || {} };
  } catch { return { defaults: { ...ECOM_DEFAULTS }, shops: {} }; }
}

// 某家店的最终参数 = defaults ← 该店覆盖
function ecomCfgFor(shop) {
  const all = readEcomCfgAll();
  const own = all.shops[shop] || {};
  return {
    shop,
    categoryFeeRate: Number(own.categoryFeeRate ?? all.defaults.categoryFeeRate ?? 0),
    paymentFeeRate: Number(own.paymentFeeRate ?? all.defaults.paymentFeeRate ?? 0),
    shippingPerOrder: Number(own.shippingPerOrder ?? all.defaults.shippingPerOrder ?? 0),
    packagingPerOrder: Number(own.packagingPerOrder ?? all.defaults.packagingPerOrder ?? 0),
    // 拿货成本按商品ID记：{ "0000000000000000000": 12.5 }
    items: own.items && typeof own.items === "object" ? own.items : {},
    configured: Object.keys(own).length > 0,
  };
}

// 这家店的 SKU 清单（按 SKU 填拿货价，一规格一行）
function skusOfShop(shop) {
  const prods = db.prepare("SELECT item_id,title FROM products WHERE shop = ?").all(shop);
  const titleOf = new Map(prods.map((p) => [p.item_id, p.title]));
  const rows = db.prepare("SELECT * FROM skus WHERE shop = ? ORDER BY item_id, price").all(shop);
  return rows.map((r) => ({
    sku_id: r.sku_id, item_id: r.item_id, spec: r.spec,
    price: r.price, stock: r.stock, status: r.status,
    title: titleOf.get(r.item_id) || "",
  }));
}

// 订单里出现过的款（归一化去重）—— 现在界面按 SKU 填成本，这个只留作参考
function orderSkuSummary(shop) {
  const norm = (s) => String(s || "")
    .replace(/带货达人[:：].*$/, "")
    .replace(/\s*[x×]\s*\d+\s*$/i, "")
    .replace(/\s+/g, " ").trim();
  const rows = shop
    ? db.prepare("SELECT sku, qty, amount FROM orders WHERE sku IS NOT NULL AND shop = ?").all(shop)
    : db.prepare("SELECT sku, qty, amount FROM orders WHERE sku IS NOT NULL").all();
  const agg = new Map();
  for (const r of rows) {
    const k = norm(r.sku);
    if (!k) continue;
    const o = agg.get(k) || { sku: k, n: 0, amt: 0 };
    o.n += Number(r.qty) || 1;
    o.amt += Number(r.amount) || 0;
    agg.set(k, o);
  }
  return [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 30)
    .map((o) => ({ ...o, amt: Math.round(o.amt * 100) / 100 }));
}

route("GET", "/api/ecom/config", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop") || "shop_demo";

  // 扣点自动识别：真实订单反算「平台综合扣点 = 1 - 商家收入 / 买家支付」
  const agg = db.prepare(
    `SELECT ROUND(SUM(coalesce(amount,0)),2) amt, ROUND(SUM(coalesce(income,amount,0)),2) inc, COUNT(*) n
     FROM orders WHERE shop = ? AND status NOT LIKE '%关闭%' AND status NOT LIKE '%取消%' AND status NOT LIKE '%退款%'`
  ).get(shop);
  const derivedFee = agg && agg.amt > 0 && agg.inc > 0 && agg.inc < agg.amt
    ? { rate: (agg.amt - agg.inc) / agg.amt, orders: agg.n, gmv: agg.amt, income: agg.inc }
    : null;

  json(res, 200, {
    config: ecomCfgFor(shop),
    skus: skusOfShop(shop),
    orderSkus: orderSkuSummary(shop),
    derivedFee,
    shops: readShops().map((s) => ({ agent: s.agent, name: s.name, platform: s.platform })),
  });
});

route("POST", "/api/ecom/config", async (req, res) => {
  const b = await readBody(req);
  const shop = String(b.shop || "").trim();
  if (!shop) return fail(res, 400, "缺字段：shop（哪家店）");

  const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
  const cur = ecomCfgFor(shop);

  // items：{ 商品ID: 拿货价 }
  let items = cur.items;
  if (b.items && typeof b.items === "object") {
    items = {};
    for (const [id, cost] of Object.entries(b.items)) {
      const c = Number(cost);
      if (!/^\d{6,}$/.test(String(id))) continue;   // sku_id 或 item_id
      if (!Number.isFinite(c) || c < 0) continue;
      items[String(id)] = c;
    }
  }

  const next = {
    categoryFeeRate: num(b.categoryFeeRate, cur.categoryFeeRate),
    paymentFeeRate: num(b.paymentFeeRate, cur.paymentFeeRate),
    shippingPerOrder: num(b.shippingPerOrder, cur.shippingPerOrder),
    packagingPerOrder: num(b.packagingPerOrder, cur.packagingPerOrder),
    items,
  };
  if (next.categoryFeeRate > 1) return fail(res, 400, "类目扣点要用小数（界面填 5 表示 5%）");
  for (const [k, v] of Object.entries(next)) {
    if (k === "items") continue;
    if (Number.isNaN(v) || v < 0 || v > 1e6) return fail(res, 400, `参数不合理：${k}=${v}`);
  }

  const all = readEcomCfgAll();
  all.shops[shop] = next;
  fs.writeFileSync(ECOM_CFG_PATH, JSON.stringify({
    _说明: "每个店铺一套参数；拿货成本按商品ID记（每个链接成本不同）。成本填 0 = 不算毛利，不会瞎猜。",
    defaults: all.defaults, shops: all.shops,
  }, null, 2) + "\n", "utf8");

  json(res, 200, { ok: true, shop, config: ecomCfgFor(shop) });
});

// ── 结算账单：费率的唯一可信来源（备注列直接写「平台服务费率2%;商品类目: …」）──
route("POST", "/api/settlements/bulk", async (req, res) => {
  const b = await readBody(req);
  const shop = String(b.shop || "").trim();
  const rows = Array.isArray(b.settlements) ? b.settlements : [];
  if (!shop || !rows.length) return fail(res, 400, "缺字段：shop / settlements");

  const at = nowIso();
  const st = db.prepare(
    `INSERT INTO settlements (shop,order_id,settle_at,order_at,item_id,paid,subsidy,base,service_fee,fee_rate,settle_amount,talent_fee,category,note,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(shop,order_id) DO UPDATE SET
       settle_at=excluded.settle_at, order_at=excluded.order_at, item_id=excluded.item_id,
       paid=excluded.paid, subsidy=excluded.subsidy, base=excluded.base,
       service_fee=excluded.service_fee, fee_rate=excluded.fee_rate, settle_amount=excluded.settle_amount,
       talent_fee=excluded.talent_fee, category=excluded.category, note=excluded.note, fetched_at=excluded.fetched_at`
  );

  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!r.order_id) continue;
      st.run(shop, String(r.order_id), r.settle_at || null, r.order_at || null, r.item_id || null,
        r.paid ?? null, r.subsidy ?? null, r.base ?? null, r.service_fee ?? null,
        r.fee_rate ?? null, r.settle_amount ?? null, r.talent_fee ?? null,
        r.category || null, r.note || null, r.fetched_at || at);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return fail(res, 500, "写结算账单失败：" + String(e.message || e).slice(0, 120));
  }

  let rates = 0;
  const list = Array.isArray(b.feeRates) ? b.feeRates : [];
  const st2 = db.prepare(
    `INSERT INTO fee_rates (shop,category,rate,samples,source,at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(shop,category) DO UPDATE SET rate=excluded.rate, samples=excluded.samples, source=excluded.source, at=excluded.at`
  );
  for (const r of list) {
    if (!r.category || r.rate == null) continue;
    st2.run(shop, r.category, Number(r.rate), Number(r.samples) || 0, "抖店结算账单", at);
    rates++;
  }

  json(res, 200, { ok: true, written: n, rates });
});

route("GET", "/api/fee-rates", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  const rows = shop
    ? db.prepare("SELECT * FROM fee_rates WHERE shop = ? ORDER BY samples DESC").all(shop)
    : db.prepare("SELECT * FROM fee_rates ORDER BY shop, samples DESC").all();
  const sets = shop
    ? db.prepare("SELECT COUNT(*) c, ROUND(SUM(service_fee),2) fee, ROUND(SUM(base),2) base FROM settlements WHERE shop = ?").get(shop)
    : { c: 0, fee: 0, base: 0 };
  json(res, 200, { rates: rows, total: rows.length, settlements: sets });
});

// ── 多窗口快照：实时 / 近7天 / 近30天 各存一份，互不覆盖 ──────────
route("POST", "/api/agents/:id/snapshot", async (req, res, p) => {
  const b = await readBody(req);
  const win = String(b.win || b.window || "").trim();
  const metrics = Array.isArray(b.metrics) ? b.metrics : [];
  if (!win || !metrics.length) return fail(res, 400, "缺字段：win / metrics");
  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO metric_snapshots (agent_id,win,key,label,value,extra,ok,at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(agent_id,win,key) DO UPDATE SET
       label=excluded.label, value=excluded.value, extra=excluded.extra, ok=excluded.ok, at=excluded.at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const m of metrics) {
      if (!m?.key) continue;
      stmt.run(p.id, win, String(m.key), m.label || null,
        m.value == null ? null : String(m.value), m.extra || null, m.ok ? 1 : 0, at);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return fail(res, 500, "写快照失败：" + String(e.message || e).slice(0, 120));
  }
  // 心跳跟着数据走：有新鲜数据 = 这个 Agent 活着，下次该在 1 小时后。
  // 之前心跳只有 ecom-plan 分析时才写，所以「上次 15:56 → 下次 16:43」会一直挂在那不动。
  try {
    const ag = db.prepare("SELECT id FROM agents WHERE id = ?").get(p.id);
    if (ag) {
      db.prepare("UPDATE agents SET alive = 1, last_run_at = ?, next_run_at = ? WHERE id = ?")
        .run(at, new Date(Date.now() + 3600_000).toISOString(), p.id);
    }
    // 店铺的数据进来，也代表「电商 Agent」在干活：它的卡片排班行据此刷新
    if (readShops().some((s) => s.agent === p.id)) {
      db.prepare("UPDATE agents SET alive = 1, last_run_at = ?, next_run_at = ? WHERE id = 'shop'")
        .run(at, new Date(Date.now() + 3600_000).toISOString());
    }
  } catch {}

  json(res, 200, { ok: true, written: n, win });
});

// 取某家店所有窗口的快照，按窗口分组
function snapshotsOf(agentId) {
  const rows = db.prepare("SELECT * FROM metric_snapshots WHERE agent_id = ? ORDER BY win, key").all(agentId);
  const out = {};
  for (const r of rows) {
    const w = out[r.win] || (out[r.win] = { at: r.at, metrics: {} });
    out[r.win].metrics[r.key] = { label: r.label, value: r.value, ok: !!r.ok, extra: r.extra };
    if (String(r.at) > String(w.at)) w.at = r.at;
  }
  return out;
}

// ── SKU 清单（规格 / 售价 / 库存 / SKUID）─────────────────
route("POST", "/api/skus/bulk", async (req, res) => {
  const b = await readBody(req);
  const shop = String(b.shop || "").trim();
  if (!shop) return fail(res, 400, "缺字段：shop");
  const rows = Array.isArray(b.skus) ? b.skus : [];
  if (!rows.length) return fail(res, 400, "缺字段：skus");

  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO skus (shop,item_id,spec,sku_id,price,stock,status,fetched_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(shop,item_id,spec) DO UPDATE SET
       sku_id=excluded.sku_id, price=excluded.price, stock=excluded.stock,
       status=excluded.status, fetched_at=excluded.fetched_at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const itemId = String(r.item_id || "").trim();
      const spec = String(r.spec || "").trim();
      if (!itemId || !spec) continue;
      stmt.run(shop, itemId, spec, r.sku_id || null,
        r.price == null ? null : Number(r.price),
        r.stock == null ? null : Number(r.stock),
        r.status || null, r.fetched_at || at);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return fail(res, 500, "写 SKU 失败：" + String(e.message || e).slice(0, 120));
  }
  json(res, 200, { ok: true, written: n });
});

route("GET", "/api/skus", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  const rows = shop
    ? db.prepare("SELECT * FROM skus WHERE shop = ? ORDER BY item_id, price").all(shop)
    : db.prepare("SELECT * FROM skus ORDER BY shop, item_id, price").all();
  json(res, 200, { skus: rows, total: rows.length });
});

// ── 商品清单（含商品ID）────────────────────────────────
route("POST", "/api/products/bulk", async (req, res) => {
  const b = await readBody(req);
  const shop = String(b.shop || "").trim();
  if (!shop) return fail(res, 400, "缺字段：shop");
  const rows = Array.isArray(b.products) ? b.products : [];
  if (!rows.length) return fail(res, 400, "缺字段：products");

  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO products (shop,item_id,title,price_min,price_max,stock,status,raw_json,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(shop,item_id) DO UPDATE SET
       title=excluded.title, price_min=excluded.price_min, price_max=excluded.price_max,
       stock=excluded.stock, status=excluded.status,
       raw_json=excluded.raw_json, fetched_at=excluded.fetched_at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const id = String(r.item_id || "").trim();
      if (!id) continue;
      stmt.run(shop, id, r.title || null,
        r.price_min == null ? null : Number(r.price_min),
        r.price_max == null ? null : Number(r.price_max),
        r.stock == null ? null : Number(r.stock),
        r.status || null, JSON.stringify(r).slice(0, 1000), r.fetched_at || at);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return fail(res, 500, "写商品失败：" + String(e.message || e).slice(0, 120));
  }
  json(res, 200, { ok: true, written: n });
});

route("GET", "/api/products", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  const rows = shop
    ? db.prepare("SELECT * FROM products WHERE shop = ? ORDER BY coalesce(title,'')").all(shop)
    : db.prepare("SELECT * FROM products ORDER BY shop, coalesce(title,'')").all();
  json(res, 200, { products: rows });
});

// 把订单里的商品名对到商品ID（订单页没有商品ID，只有标题）
// 纪律：**只有唯一匹配才写**。同标题对应多个商品链接时宁可不写，
// 也不要把 10 单全挂到同一个 ID 上假装精确。
function linkOrdersToProducts(shop) {
  const prods = db.prepare("SELECT item_id,title FROM products WHERE shop = ?").all(shop)
    .filter((p) => p.title && String(p.title).trim());
  const orders = db.prepare("SELECT order_id,sku FROM orders WHERE shop = ? AND sku IS NOT NULL").all(shop);
  const upd = db.prepare("UPDATE orders SET item_id = ? WHERE shop = ? AND order_id = ?");
  let linked = 0, ambiguous = 0, missed = 0;
  db.exec("BEGIN");
  try {
    for (const o of orders) {
      const sku = String(o.sku || "").trim();
      // 标题被订单商品名包含（订单名 = 商品标题 + 规格）
      const hits = prods.filter((p) => sku.includes(String(p.title).trim()));
      // 如果有更长的标题更贴合，只留最长的那些
      const longest = hits.length ? Math.max(...hits.map((p) => String(p.title).trim().length)) : 0;
      const best = hits.filter((p) => String(p.title).trim().length === longest);

      if (best.length === 1) { upd.run(best[0].item_id, shop, o.order_id); linked++; }
      else if (best.length > 1) { upd.run(null, shop, o.order_id); ambiguous++; }
      else { upd.run(null, shop, o.order_id); missed++; }
    }
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
  }
  return { linked, ambiguous, missed, total: orders.length };
}

route("POST", "/api/orders/link", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  if (!shop) return fail(res, 400, "缺 shop");
  json(res, 200, { ok: true, ...linkOrdersToProducts(shop) });
});

// ── 批量：对勾选的店铺逐个分析（各自口径），或统一按某个时间窗重取再分析 ──
const WIN_OF_LABEL = { "实时": "today", "近7天": "7d", "近30天": "30d" };

route("POST", "/api/ecom/batch", async (req, res) => {
  const b = await readBody(req);
  const agents = Array.isArray(b.agents) ? b.agents.map(String).filter(Boolean) : [];
  if (!agents.length) return fail(res, 400, "没选店铺（agents 为空）");
  const tab = b.tab ? String(b.tab) : null;
  if (tab && !TAB_TO_WINDOW[tab]) return fail(res, 400, `时间窗只能是：${Object.keys(TAB_TO_WINDOW).join(" / ")}`);

  const spawn = (args, env, timeoutMs = 240000) => new Promise((resolve) => {
    const child = spawnProcess(process.execPath, args, {
      cwd: import.meta.dirname, env: { ...process.env, ...env }, windowsHide: true,
    });
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });

  const shopsNow = readShops();
  const results = [];

  for (const agent of agents) {
    const shop = shopsNow.find((s) => s.agent === agent);
    if (!shop) { results.push({ agent, ok: false, error: "店铺不存在" }); continue; }

    // 每家用「自己的」窗口；只有显式给了 tab 才统一覆盖
    const label = tab || shop.window || "实时";
    const win = WIN_OF_LABEL[label] || "today";
    const steps = [];

    if (tab) {
      const conn = readConnectors().connectors.find((c) => c.agent === agent && c.module === "browser-session" && c.enabled);
      if (conn) {
        const s1 = await spawn(["sync.mjs", conn.id], { ECOM_TAB: tab });
        const ok1 = s1.code === 0 && !/0 成功 \/ \d+ 失败/.test(s1.out || "");
        steps.push({ step: "抓数", ok: ok1 });
        if (ok1) {
          const sn = readShops();
          const t0 = sn.find((x) => x.agent === agent);
          if (t0) { t0.window = tab; t0.window_at = nowIso(); fs.writeFileSync(SHOPS_PATH, JSON.stringify(sn, null, 2) + "\n", "utf8"); }
        } else {
          results.push({ agent, name: shop.name, ok: false, window: label, steps, error: "抓数失败" });
          continue;
        }
      }
    }

    const s2 = await spawn(["ecom-plan.mjs", "--shop", agent, "--window", win]);
    steps.push({ step: "分析", ok: s2.code === 0 });
    results.push({ agent, name: shop.name, ok: s2.code === 0, window: label, steps });
  }

  // 全部跑完，CEO 统一裁决一次
  const s3 = await spawn(["ceo.mjs"]);
  kickBroadcast();
  json(res, 200, {
    ok: results.every((r) => r.ok) && s3.code === 0,
    results, ceo: { ok: s3.code === 0, out: (s3.out || "").trim().slice(-1200) },
  });
});

// ── 一键按时间窗重取 → 分析 → CEO 下达指令 ─────────────────
// POST /api/ecom/refresh { shop, tab: "实时"|"近1天"|"近7天"|"近30天" }
const TAB_TO_WINDOW = { "实时": "today", "近1天": "today", "近7天": "7d", "近30天": "30d" };

route("POST", "/api/ecom/refresh", async (req, res) => {
  const b = await readBody(req);
  const wanted = String(b.shop || "shop_demo").trim();
  const tab = String(b.tab || "实时").trim();
  if (!TAB_TO_WINDOW[tab]) return fail(res, 400, `时间窗只能是：${Object.keys(TAB_TO_WINDOW).join(" / ")}`);

  const allShops = readShops();
  const targets = wanted === "__all__"
    ? allShops.map((s) => s.agent)
    : [wanted];
  if (!targets.length) return fail(res, 400, "没有店铺可刷新");

  const spawn = (args, env, timeoutMs = 180000) => new Promise((resolve) => {
    const child = spawnProcess(process.execPath, args, {
      cwd: import.meta.dirname,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });

  const steps = [];
  const perShop = [];

  for (const shop of targets) {
    const conn = readConnectors().connectors.find((c) => c.agent === shop && c.module === "browser-session" && c.enabled);
    if (!conn) {
      perShop.push({ shop, ok: false, error: "没有可用的页面连接器（扫码/浏览器）" });
      continue;
    }

    // ① 按时间窗重抓这家店
    const s1 = await spawn(["sync.mjs", conn.id], { ECOM_TAB: tab }, 180000);
    const ok1 = s1.code === 0 && !/0 成功 \/ \d+ 失败/.test(s1.out || "");
    steps.push({ shop, step: "抓数", tab, ok: ok1, out: (s1.out || s1.err || "").trim().slice(-500) });

    // ② 按窗口分析这家店
    const s2 = await spawn(["ecom-plan.mjs", "--shop", shop, "--window", TAB_TO_WINDOW[tab]], {}, 180000);
    steps.push({ shop, step: "分析", ok: s2.code === 0, out: (s2.out || s2.err || "").trim().slice(-900) });

    // ③ 记住窗口
    const shopsNow = readShops();
    const t0 = shopsNow.find((x) => x.agent === shop);
    if (t0) { t0.window = tab; t0.window_at = nowIso(); fs.writeFileSync(SHOPS_PATH, JSON.stringify(shopsNow, null, 2) + "\n", "utf8"); }

    perShop.push({ shop, ok: ok1 && s2.code === 0 });
  }

  // ④ 全部店跑完，再让 CEO 统一裁决一次（避免每店派一轮重复活）
  const s3 = await spawn(["ceo.mjs"], {}, 180000);
  steps.push({ shop: "__all__", step: "CEO", ok: s3.code === 0, out: (s3.out || s3.err || "").trim().slice(-1600) });

  kickBroadcast();
  json(res, 200, {
    ok: perShop.every((s) => s.ok) && s3.code === 0,
    shop: wanted, shops: targets, tab, window: TAB_TO_WINDOW[tab], steps,
  });
});

// ── 订单明细：抓下来的逐单数据 ────────────────────────────────
route("POST", "/api/orders/bulk", async (req, res) => {
  const b = await readBody(req);
  const shop = String(b.shop || "").trim();
  if (!shop) return fail(res, 400, "缺字段：shop（这家店属于哪个 agent）");
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) return fail(res, 400, "缺字段：rows（没有数据可写）");
  if (rows.length > 5000) return fail(res, 413, "一次最多写 5000 行");

  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO orders (shop,order_id,sku,qty,amount,income,status,created_at,raw_json,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(shop,order_id) DO UPDATE SET
       sku=excluded.sku, qty=excluded.qty, amount=excluded.amount, income=excluded.income,
       status=excluded.status, created_at=excluded.created_at,
       raw_json=excluded.raw_json, fetched_at=excluded.fetched_at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const oid = String(r.order_id || r.id || "").trim();
      if (!oid) continue;
      stmt.run(
        shop, oid, r.sku || null,
        r.qty == null ? null : Number(r.qty),
        r.amount == null ? null : Number(r.amount),
        r.income == null ? null : Number(r.income),
        r.status || null, r.created_at || null,
        JSON.stringify(r).slice(0, 2000), r.fetched_at || at
      );
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return fail(res, 500, "写库失败：" + String(e.message || e).slice(0, 120));
  }
  json(res, 200, { ok: true, written: n });
});

route("GET", "/api/orders", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  const limit = Math.min(500, Number(u.searchParams.get("limit") || 100));
  const where = shop ? "WHERE shop = ?" : "";
  const rows = shop
    ? db.prepare(`SELECT * FROM orders ${where} ORDER BY coalesce(created_at,'') DESC LIMIT ?`).all(shop, limit)
    : db.prepare(`SELECT * FROM orders ORDER BY coalesce(created_at,'') DESC LIMIT ?`).all(limit);
  json(res, 200, { rows, total: db.prepare("SELECT COUNT(*) c FROM orders").get().c });
});

// 按店聚合：电商最常用的几个口径
route("GET", "/api/orders/stats", (req, res) => {
  const u = new URL(req.url, "http://x");
  const shop = u.searchParams.get("shop");
  const w = shop ? "WHERE shop = ?" : "";
  const args = shop ? [shop] : [];
  const byStatus = db.prepare(`SELECT status, COUNT(*) n, ROUND(SUM(coalesce(amount,0)),2) amt FROM orders ${w} GROUP BY status ORDER BY n DESC`).all(...args);
  const total = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(coalesce(amount,0)),2) amt FROM orders ${w}`).get(...args);
  const byDay = db.prepare(`SELECT substr(coalesce(created_at,''),1,10) d, COUNT(*) n, ROUND(SUM(coalesce(amount,0)),2) amt FROM orders ${w} GROUP BY d ORDER BY d DESC LIMIT 7`).all(...args);
  json(res, 200, { shop: shop || "全部", total, byStatus, byDay });
});

// ── 模型接入配置（LLM 文案 / 图像生成）─────────────────────
const AI_PATH = path.join(import.meta.dirname, "ai.config.json");

const AI_DEFAULTS = {
  llm: { provider: "ollama", base_url: "http://127.0.0.1:11434", api_key: "", model: "qwen2.5:7b" },
  image: { provider: "jimeng", base_url: "", api_key: "", access_key: "", secret_key: "", model: "seedream-4.0" },
};

function readAi() {
  try {
    const j = JSON.parse(fs.readFileSync(AI_PATH, "utf8"));
    return {
      llm: { ...AI_DEFAULTS.llm, ...(j.llm || {}) },
      image: { ...AI_DEFAULTS.image, ...(j.image || {}) },
      updated_at: j.updated_at || null,
    };
  } catch {
    return { llm: { ...AI_DEFAULTS.llm }, image: { ...AI_DEFAULTS.image }, updated_at: null };
  }
}
function writeAi(cfg) {
  cfg.updated_at = nowIso();
  fs.writeFileSync(AI_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
const maskKey = (s) => (!s ? "" : s.length <= 8 ? "••••" : `${s.slice(0, 4)}••••${s.slice(-4)}`);

route("GET", "/api/settings/ai", (req, res) => {
  const c = readAi();
  json(res, 200, {
    llm: { ...c.llm, api_key: "", has_key: !!c.llm.api_key, key_masked: maskKey(c.llm.api_key) },
    image: { ...c.image, api_key: "", secret_key: "", has_key: !!(c.image.api_key || (c.image.access_key && c.image.secret_key)), key_masked: maskKey(c.image.api_key || c.image.access_key) },
    updated_at: c.updated_at,
    presets: {
      llm: [
        { id: "ollama", name: "本地 Ollama（免费，数据不出机器）", base_url: "http://127.0.0.1:11434", model: "qwen2.5:7b", need_key: false },
        { id: "deepseek", name: "DeepSeek（云端，便宜）", base_url: "https://api.deepseek.com", model: "deepseek-chat", need_key: true },
        { id: "openai", name: "OpenAI 兼容接口", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", need_key: true },
        { id: "custom", name: "自定义（任何 OpenAI 兼容端点）", base_url: "", model: "", need_key: true },
      ],
      image: [
        { id: "zhipu", name: "智谱 CogView-3-Flash（国内直连，这个模型免费）", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash", need_key: true, keys: ["api_key"] },
        { id: "modelscope", name: "魔搭 ModelScope（每天免费额度，通义/FLUX 都能调）", base_url: "https://api-inference.modelscope.cn/v1", model: "Qwen/Qwen-Image", need_key: true, keys: ["api_key"] },
        { id: "siliconflow", name: "硅基流动 Kolors（国内直连，送额度，中文强）", base_url: "https://api.siliconflow.cn/v1", model: "Kwai-Kolors/Kolors", need_key: true, keys: ["api_key"] },
        { id: "nanobanana", name: "Nano Banana（Gemini，海外，国内注册难）", base_url: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-image", need_key: true, keys: ["api_key"] },
        { id: "jimeng", name: "即梦 / Seedream（字节，抖店同生态）", base_url: "https://visual.volcengineapi.com", model: "seedream-4.0", need_key: true, keys: ["access_key", "secret_key"] },
        { id: "openai", name: "OpenAI 图像（gpt-image-1）", base_url: "https://api.openai.com/v1", model: "gpt-image-1", need_key: true, keys: ["api_key"] },
        { id: "comfy", name: "本地 ComfyUI（免费，要显卡）", base_url: "http://127.0.0.1:8188", model: "flux-dev", need_key: false, keys: [] },
        { id: "custom", name: "自定义", base_url: "", model: "", need_key: true, keys: ["api_key"] },
      ],
    },
  });
});

route("POST", "/api/settings/ai", async (req, res) => {
  const b = await readBody(req);
  const cur = readAi();
  for (const kind of ["llm", "image"]) {
    const inc = b[kind];
    if (!inc) continue;
    for (const k of ["provider", "base_url", "model", "access_key", "secret_key"]) {
      if (inc[k] !== undefined) cur[kind][k] = String(inc[k]).trim();
    }
    if (inc.api_key) cur[kind].api_key = String(inc.api_key).trim();
    if (inc.clear_api_key) cur[kind].api_key = "";
  }
  writeAi(cur);
  json(res, 200, { ok: true, updated_at: cur.updated_at });
});

// 测试连通性：只验能不能连上/鉴权，不花钱（不真生成图）
route("POST", "/api/settings/ai/test", async (req, res) => {
  const b = await readBody(req);
  const kind = String(b.kind || "llm");
  const cfg = readAi()[kind] || {};
  const base = String(cfg.base_url || "").replace(/\/+$/, "");
  const t0 = Date.now();
  const done = (ok, message, extra) => json(res, 200, {
    ok, kind, provider: cfg.provider, model: cfg.model, latency_ms: Date.now() - t0, message, ...(extra || {}),
  });

  if (!base) return done(false, "还没填 base_url");

  try {
    if (kind === "llm") {
      if (cfg.provider === "ollama") {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return done(false, `Ollama 返回 HTTP ${r.status}`);
        const j = await r.json().catch(() => ({}));
        const models = (j.models || []).map((m) => m.name);
        const has = models.includes(cfg.model) || models.some((m) => m.startsWith(String(cfg.model).split(":")[0]));
        return done(true,
          has ? `连上了，${cfg.model} 在本地` : `连上了，但本地没装 ${cfg.model}（现有：${models.slice(0, 5).join(", ") || "无"}）`,
          { models: models.slice(0, 20), model_ready: has });
      }
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.api_key || ""}` },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "回复 ok" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      if (!r.ok) return done(false, `HTTP ${r.status}：${String(text).slice(0, 160)}`);
      let out = "";
      try { out = JSON.parse(text)?.choices?.[0]?.message?.content || ""; } catch {}
      return done(true, `通了，模型回了「${String(out).slice(0, 20)}」`);
    }

    if (["openai", "zhipu", "siliconflow", "modelscope", "custom"].includes(cfg.provider)) {
      if (!cfg.api_key) return done(false, "缺 api_key");
      const r = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${cfg.api_key}` },
        signal: AbortSignal.timeout(12000),
      }).catch((e) => ({ ok: false, status: 0, _e: e }));
      if (r.ok) return done(true, `能连上 ${cfg.provider}（${cfg.model}）`);
      if (r.status === 404) return done(true, "密钥格式对（该厂商不提供 /models 列表，直接去跑一次出图验证）");
      return done(false, `连不上：HTTP ${r.status || r._e?.message || ""}`);
    }
    if (cfg.provider === "nanobanana") {
      if (!cfg.api_key) return done(false, "缺 api_key（Google AI Studio 创建的 key）");
      const r = await fetch(`${base}/models?key=${encodeURIComponent(cfg.api_key)}`, {
        signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      if (!r.ok) {
        let why = text.slice(0, 160);
        try { why = JSON.parse(text)?.error?.message || why; } catch {}
        return done(false, `鉴权失败 HTTP ${r.status}：${why}`);
      }
      let names = [];
      try {
        names = (JSON.parse(text).models || []).map((m) => String(m.name).replace("models/", ""));
      } catch {}
      const has = names.some((n) => n.includes(cfg.model) || n.includes("flash-image"));
      return done(true,
        has ? `鉴权通过，${cfg.model} 可用` : `鉴权通过，但列表里没见 ${cfg.model}（现有图像模型：${names.filter((n) => n.includes("image")).slice(0, 4).join(", ") || "未列出" }）`,
        { model_ready: has, checked: "models_list" });
    }
    if (cfg.provider === "comfy") {
      const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(6000) }).catch(() => null);
      return r && r.ok ? done(true, "ComfyUI 连上了") : done(false, "连不上 ComfyUI（启动了没）");
    }
    if (cfg.provider === "jimeng") {
      if (!cfg.access_key || !cfg.secret_key) return done(false, "即梦要 AccessKey + SecretKey（火山引擎控制台拿）");
      const r = await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(6000) }).catch(() => null);
      return done(true, `凭证已填（AK ${maskKey(cfg.access_key)}）；域名${r ? "可达" : "未直连"}，真正出图在生成时验签`, { checked: "credentials_only" });
    }
    if (cfg.provider === "openai") {
      if (!cfg.api_key) return done(false, "缺 api_key");
      const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${cfg.api_key}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return done(false, `鉴权失败 HTTP ${r.status}`);
      return done(true, "鉴权通过（只验 key，不生成图）");
    }
    return done(false, "这个 provider 没有内置测试，请在生成时验证");
  } catch (e) {
    return done(false, `连不上：${String(e.message || e).slice(0, 120)}`);
  }
});

// ── 授权政策：政策内自动执行，破线才上报 ──────────────────
const POLICIES_PATH = path.join(import.meta.dirname, "policies.json");
function readPolicies() {
  try {
    const j = JSON.parse(fs.readFileSync(POLICIES_PATH, "utf8"));
    return { auto_exec: {}, protect_product_ids: [], protect_title_keywords: [], max_single_cny: 200, ...j };
  } catch {
    // 读不到就退化成「全部要批」，宁严不松
    return { auto_exec: {}, protect_product_ids: [], protect_title_keywords: [], max_single_cny: 0 };
  }
}

// 判断某个动作能不能自动做 → {allow, why, limit}
function policyCheck(action, params) {
  const P = readPolicies();
  const rule = P.auto_exec?.[action];
  const pid = String(params?.product_id || "");

  // 1) 保护款：任何写动作都不许自动
  const protectedIds = (P.protect_product_ids || []).map(String);
  if (pid && protectedIds.includes(pid)) {
    return { allow: false, why: `商品 ${pid} 在保护名单里（主推款），不能自动动` };
  }
  if (pid && (P.protect_title_keywords || []).length) {
    const row = db.prepare("SELECT title FROM products WHERE item_id = ? LIMIT 1").get(pid);
    const hit = row && P.protect_title_keywords.find((k) => String(row.title || "").includes(k));
    if (hit) return { allow: false, why: `商品 ${pid} 标题含「${hit}」，属保护款，不能自动动` };
  }

  // 2) 金额红线
  const amount = Number(params?.amount ?? params?.refund_amount ?? NaN);
  if (Number.isFinite(amount) && amount > Number(P.max_single_cny || 0)) {
    return { allow: false, why: `单笔金额 ${amount} 超过政策上限 ${P.max_single_cny}，要你批` };
  }

  if (!rule) return { allow: false, why: "这个动作不在政策白名单里，默认要你批" };

  // 3) 改价：看幅度
  if (action === "douyin.price") {
    const pct = Math.abs(Number(params?.change_pct ?? NaN));
    const maxPct = Number(rule.max_pct || 0);
    if (Number.isFinite(pct) && maxPct > 0 && pct <= maxPct) {
      return { allow: true, why: `改价幅度 ${pct}% 在政策内（≤${maxPct}%）`, limit: maxPct };
    }
    return { allow: false, why: rule.why || `改价幅度没给或超过 ${maxPct}%，要你批` };
  }

  // 4) 售后：小额可自动同意
  if (action === "douyin.aftersale") {
    const amt = Number(params?.amount ?? NaN);
    const below = Number(rule.auto_agree_below || 0);
    if (Number.isFinite(amt) && below > 0 && amt <= below && String(params?.decision) === "agree") {
      return { allow: true, why: `售后金额 ${amt} ≤ ${below}，政策允许自动同意` };
    }
    return rule.allow ? { allow: true, why: rule.why } : { allow: false, why: rule.why || "售后要你批" };
  }

  // 5) 其余按白名单
  return rule.allow === true
    ? { allow: true, why: rule.why || "政策允许" }
    : { allow: false, why: rule.why || "政策未授权自动执行" };
}

// ── 执行器：真去平台上动手（发货 / 上下架 / 改价 / 售后）────────────
// 默认 dry-run；高危动作必须带一个我批过的决策包；每次执行（含 dry-run）都落审计。
route("GET", "/api/exec", async (req, res) => {
  await import("./executors/douyin-shop.mjs"); // 注册动作
await import("./executors/douyin-media.mjs"); // 图片类：上传素材 + 换主图
  const { registry, RISK } = await import("./executors/_base.mjs");
  json(res, 200, {
    actions: [...registry.values()].map((a) => ({
      action: a.action, platform: a.platform, method: a.method, risk: a.risk,
      needApproval: RISK[a.risk]?.needApproval ?? true, fields: a.fields, describe: a.describe,
    })),
    recent: db.prepare("SELECT id,action,target,dry_run,ok,error,decision_id,at FROM executions ORDER BY id DESC LIMIT 20").all(),
  });
});

route("POST", "/api/exec/:action", async (req, res, p) => {
  const { registry, RISK, ExecError } = await import("./executors/_base.mjs");
  await import("./executors/douyin-shop.mjs");
  await import("./executors/douyin-media.mjs");
  const ex = registry.get(p.action);
  if (!ex) return fail(res, 404, `没有这个执行动作：${p.action}（GET /api/exec 看全部）`);

  const b = await readBody(req);
  const params = b.params || {};
  const dryRun = b.confirm !== true;
  const decisionId = b.decision_id ? Number(b.decision_id) : null;

  // 1) 必填校验
  try {
    const { requireFields } = await import("./executors/_base.mjs");
    requireFields(params, ex.fields);
  } catch (e) { return fail(res, e.status || 400, e.message); }

  // 2) 闸门：先看政策能不能自动做，再看有没有我批过的决策包
  let policy = { allow: true, why: "低风险动作，无需审批" };
  if (RISK[ex.risk]?.needApproval) {
    policy = policyCheck(ex.action, params);

    if (!policy.allow) {
      // 政策不让自动做 → 必须带已批决策包；没带就直接拒，并把理由说清
      if (!decisionId) {
        return fail(res, 403,
          `「${ex.describe}」需要你批：${policy.why}。` +
          `流程是「开决策包 → 你批 → 带 decision_id 执行」，不能直接动。`);
      }
      const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId);
      if (!d) return fail(res, 404, `决策包 #${decisionId} 不存在`);
      if (!["agree", "conditional"].includes(d.answer)) {
        return fail(res, 403, `决策包 #${decisionId} 的答复是「${ANSWER_LABEL[d.answer] || "未回"}」，不是同意/附条件同意，不许执行。`);
      }
    }
    // policy.allow = true 时放行：执行记录里会写上「依据哪条政策」
  }

  // 3) 幂等：真跑过的同一把钥匙直接返回上次结果
  const idemKey = b.idem_key || `${ex.action}:${JSON.stringify(params)}`;
  if (!dryRun) {
    const prev = db.prepare("SELECT * FROM executions WHERE idem_key = ? AND dry_run = 0 AND ok = 1").get(idemKey);
    if (prev) {
      return json(res, 200, { ok: true, deduped: true, executed_at: prev.at, response: prev.response ? JSON.parse(prev.response) : null });
    }
  }

  // 4) 拼请求
  let request;
  try { request = await ex.buildRequest(params, { dryRun }); }
  catch (e) {
    const msg = e.message || String(e);
    db.prepare(
      "INSERT INTO executions (action,target,params_json,decision_id,dry_run,ok,idem_key,error,requested_by,at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(ex.action, b.target || null, JSON.stringify(params), decisionId, dryRun ? 1 : 0, 0, idemKey, msg, b.requested_by || "cli", nowIso());
    return fail(res, e.status || 400, msg);
  }

  const safe = { path: request.path, method: request.method, param_json: request.paramJson, note: request.note || null };

  // 5) dry-run：只把「会发什么」告诉你
  if (dryRun) {
    db.prepare(
      "INSERT INTO executions (action,target,params_json,decision_id,dry_run,ok,idem_key,request_path,requested_by,at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(ex.action, b.target || null, JSON.stringify(params), decisionId, 1, null, idemKey, request.path, b.requested_by || "cli", nowIso());
    return json(res, 200, {
      ok: true, dry_run: true, request: safe,
      policy: { auto: policy.allow, why: policy.why, limit: policy.limit ?? null },
      note: "这是 dry-run：什么都没发出去。要真发：confirm=true",
    });
  }

  // 6) 真发
  try {
    const body = await ex.send(request, params);
    db.prepare(
      "INSERT INTO executions (action,target,params_json,decision_id,dry_run,ok,idem_key,request_path,response,requested_by,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(ex.action, b.target || null, JSON.stringify(params), decisionId, 0, 1, idemKey, request.path, JSON.stringify(body).slice(0, 2000), b.requested_by || "cli", nowIso());
    json(res, 200, { ok: true, dry_run: false, response: body });
  } catch (e) {
    db.prepare(
      "INSERT INTO executions (action,target,params_json,decision_id,dry_run,ok,idem_key,request_path,error,requested_by,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(ex.action, b.target || null, JSON.stringify(params), decisionId, 0, 0, idemKey, request.path, String(e.message || e).slice(0, 500), b.requested_by || "cli", nowIso());
    fail(res, e.status || 502, e.message || String(e));
  }
});

// ── 店铺层：能开 N 个店，每个店 = 一个 Agent + 一条连接器 ────────────
route("GET", "/api/shops", (req, res) => {
  const shops = readShops();
  const st = state();
  json(res, 200, {
    platforms: Object.entries(PLATFORMS).map(([id, p]) => ({
      id, name: p.name, module: p.module, metric: p.metric, envs: p.envs,
      creds_ready: p.envs.length ? p.envs.every((e) => !!process.env[e]) : true,
    })),
    shops: shops.map((s) => {
      const a = st.agents.find((x) => x.id === s.agent) || {};
      const plat = PLATFORMS[s.platform] || {};
      return {
        ...s,
        platform_name: plat.name || s.platform,
        agent_name: a.name || s.agent,
        alive: a.alive ?? 0,
        metric_label: a.metric_label || s.metric,
        metric_value: a.metric_value || "—",
        metric_extra: a.metric_extra || "",
        last_run_at: a.last_run_at || null,
        creds_ready: (plat.envs || []).every((e) => !!process.env[e]),
        envs: plat.envs || [],
        // 这批数是按哪个时间窗抓的
        window_label: s.window || "实时",
        window_at: s.window_at || null,
        // 这家店有多少订单明细 / 多少商品（界面据此判断能不能填成本）
        order_count: db.prepare("SELECT COUNT(*) c FROM orders WHERE shop = ?").get(s.agent)?.c ?? 0,
        product_count: db.prepare("SELECT COUNT(*) c FROM products WHERE shop = ?").get(s.agent)?.c ?? 0,
        // 经营参数是否填全（没填就卡住算毛利）
        params_ready: (() => {
          const c = ecomCfgFor(s.agent);
          const items = c.items || {};
          const n = Object.values(items).filter((v) => Number(v) > 0).length;
          if (!n) return false;
          if (Number(c.categoryFeeRate) > 0) return true;
          // 没手填扣点时，只要能用真实订单反算出来，也算齐了
          const agg = db.prepare(
            `SELECT ROUND(SUM(coalesce(amount,0)),2) amt, ROUND(SUM(coalesce(income,amount,0)),2) inc
             FROM orders WHERE shop = ? AND status NOT LIKE '%关闭%' AND status NOT LIKE '%取消%' AND status NOT LIKE '%退款%'`
          ).get(s.agent);
          return !!(agg && agg.amt > 0 && agg.inc > 0 && agg.inc < agg.amt);
        })(),
        // 各时间窗的快照（实时 / 近7天 / 近30天），鼠标悬停看的就是它
        windows: snapshotsOf(s.agent),
        // 这家店的其他指标（同一 Agent 的多条连接器各自写一行）
        // 顺序按 connectors.json 里 metrics 的声明顺序排，别按字母乱排
        extras: (() => {
          const connsNow = readConnectors().connectors;
          const orderOf = (key) => {
            for (const cc of connsNow) {
              if (!Array.isArray(cc.metrics)) continue;
              const i = cc.metrics.findIndex((m) => m.key === key);
              if (i >= 0) return i;
            }
            return 999;
          };
          return (st.submetrics || [])
            .filter((m) => m.agent_id === s.agent && m.key !== s.connector)
            .sort((x, y) => orderOf(x.key) - orderOf(y.key) || String(x.key).localeCompare(String(y.key)))
            .map((m) => ({ label: m.label || m.key, value: m.value, ok: !!m.ok, extra: m.extra }));
        })(),
      };
    }),
  });
});

route("POST", "/api/shops", async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || "").trim();
  if (!name) return fail(res, 400, "缺字段：name（店铺名）");
  const platform = String(b.platform || "csv");
  if (!PLATFORMS[platform]) return fail(res, 400, `不认识的平台：${platform}`);
  const mode = b.mode === "api" ? "api" : b.mode === "browser" ? "browser" : "csv";
  const metric = String(b.metric || PLATFORMS[platform].metric).trim();

  const shops = readShops();
  const conns = readConnectors();
  // 不给 id 就按平台起名：pdd / pdd2 / taobao / taobao2 ……，别从中文字里抠字母
  const explicit = b.agent || b.id;
  const base = explicit ? slug(explicit) : slug(platform);
  const agentId = uniqueAgentId(base, shops, conns);
  const connectorId = `${agentId}-${mode}`;

  db.prepare(
    "INSERT INTO agents (id,name,mandate,scope,alive,last_run_at,next_run_at,shift_json,metric_label,metric_value,metric_extra) VALUES (?,?,?,?,0,NULL,NULL,'[]',?,NULL,NULL)"
  ).run(agentId, `${name} Agent`, `管${name}的订单、发货、售后`, "P2", metric);

  const conn = mode === "api"
    ? { id: connectorId, enabled: false, module: PLATFORMS[platform].module, agent: agentId, label: metric,
        ...(b.method ? { method: b.method } : {}), ...(b.param ? { param: b.param } : {}) }
    : mode === "browser"
      ? { id: connectorId, enabled: true, module: "browser-session", agent: agentId, label: metric,
          site: b.site || agentId, url: b.url || null, selector: b.selector || null,
          ...(b.regex ? { regex: b.regex } : {}),
          pick: b.pick || "number", wait: Number(b.wait || 8000) }
      : { id: connectorId, enabled: true, module: "csv", agent: agentId, label: metric,
          path: b.path || `data/${agentId}.csv`, count: b.count !== false,
          ...(b.sum ? { sum: b.sum } : {}), ...(b.value ? { value: b.value } : {}), ...(b.where ? { where: b.where } : {}) };
  conns.connectors.push(conn);
  fs.writeFileSync(CONNECTORS_PATH, JSON.stringify(conns, null, 2) + "\n", "utf8");

  const shop = {
    id: agentId, name, platform, agent: agentId, mode, metric, connector: connectorId,
    connect: mode === "csv" ? { path: conn.path, count: conn.count, sum: conn.sum, value: conn.value, where: conn.where }
      : mode === "browser" ? { site: conn.site, url: conn.url, selector: conn.selector }
      : null,
    api: mode === "api" ? { module: conn.module, method: conn.method || null } : null,
    created_at: nowIso(),
  };
  shops.push(shop);
  fs.writeFileSync(SHOPS_PATH, JSON.stringify(shops, null, 2) + "\n", "utf8");

  const prof = readProfile();
  prof.business = prof.business || {};
  prof.business.shops = [...(prof.business.shops || []).filter((s) => s.id !== agentId), { id: agentId, name, platform }];
  writeProfile(prof);

  json(res, 201, { ok: true, shop, needFile: mode === "csv" ? conn.path : null });
});

route("DELETE", "/api/shops/:id", (req, res, p) => {
  const shops = readShops();
  const shop = shops.find((s) => s.id === p.id || s.agent === p.id);
  if (!shop) return fail(res, 404, "没有这家店");
  const open = db.prepare("SELECT COUNT(*) c FROM cards WHERE owner=? AND status NOT IN ('done','cancelled')").get(shop.agent).c;
  if (open) return fail(res, 409, `${shop.name} 还有 ${open} 件没结的卡，先处理完再删`);

  fs.writeFileSync(SHOPS_PATH, JSON.stringify(shops.filter((s) => s !== shop), null, 2) + "\n", "utf8");
  const conns = readConnectors();
  conns.connectors = conns.connectors.filter((c) => c.id !== shop.connector);
  fs.writeFileSync(CONNECTORS_PATH, JSON.stringify(conns, null, 2) + "\n", "utf8");
  db.prepare("DELETE FROM agents WHERE id=?").run(shop.agent);
  const prof = readProfile();
  if (prof.business?.shops) prof.business.shops = prof.business.shops.filter((s) => s.id !== shop.agent);
  writeProfile(prof);
  json(res, 200, { ok: true });
});

// 「试连」：真跑一次这家店的连接器，结果原样返回（成败都不编）
route("POST", "/api/shops/:id/test", async (req, res, p) => {
  const shops = readShops();
  const shop = shops.find((s) => s.id === p.id || s.agent === p.id);
  if (!shop) return fail(res, 404, "没有这家店");
  const conns = readConnectors();
  const cfg = conns.connectors.find((c) => c.id === shop.connector);
  if (!cfg) return fail(res, 404, "这家店的连接器配置丢了（connectors.json 里找不到）");
  const key = cfg.module || cfg.id;

  let mod;
  try { mod = (await import(`./connectors/${key}.mjs`)).default; }
  catch { return fail(res, 400, `没有连接器模块：connectors/${key}.mjs`); }

  let out;
  try { out = await mod.run(cfg); } catch (e) { out = { ok: false, error: String(e.message || e) }; }

  if (out.ok) {
    db.prepare("UPDATE agents SET alive=1, last_run_at=?, metric_label=?, metric_value=?, metric_extra=? WHERE id=?")
      .run(nowIso(), cfg.label || shop.metric, String(out.value), out.extra || null, shop.agent);
  } else {
    db.prepare("UPDATE agents SET alive=0, last_run_at=?, metric_extra=? WHERE id=?")
      .run(nowIso(), `试连失败：${String(out.error).slice(0, 40)}`, shop.agent);
  }
  json(res, 200, { ok: out.ok, value: out.value, extra: out.extra, error: out.error, report: out.report });
});

route("GET", "/api/cards/:id", (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  json(res, 200, { ...c, logs: Q.logs.all(c.id) });
});

// 派活：没有「怎么算完成」和「第几天回看」就不许开卡
route("POST", "/api/cards", async (req, res) => {
  const b = await readBody(req);
  const need = ["title", "why", "deliverable", "done_def", "level", "owner", "check_day"];
  for (const k of need) {
    if (b[k] == null || String(b[k]).trim() === "") return fail(res, 400, `缺字段：${k}`);
  }
  if (Number(b.check_day) <= 0) return fail(res, 400, "check_day 必须是正整数（第几天回看）");
  const t = nowIso();
  const info = db.prepare(`INSERT INTO cards
    (title,why,deliverable,done_def,level,owner,status,check_day,created_day,decision_id,verdict,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.title, b.why, b.deliverable, b.done_def, b.level, b.owner,
    b.status || "todo", Number(b.check_day), today(), b.decision_id ?? null, null, t, t
  );
  const id = Number(info.lastInsertRowid);
  logCard(id, b.actor || "ceo", "派活", `${b.level} · ${b.owner}`);
  json(res, 201, { ok: true, id });
});

// 改状态。review → done 必须走验收（另设接口），这里拦住
route("POST", "/api/cards/:id/status", async (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  const b = await readBody(req);
  const next = b.status;
  const ok = ["todo", "doing", "review", "blocked", "cancelled"];
  if (!ok.includes(next)) return fail(res, 400, `状态只能是 ${ok.join(" / ")}；done 请走 /verdict`);

  // P0 闸门：大事没我批过，不许开工（认 agree / conditional，不认「没人回」）
  if (c.level === "P0" && ["doing", "review"].includes(next) && c.status !== next) {
    if (!approvedDecisionFor(c.id)) {
      return fail(res, 403, "P0 大事：没过我的决策包，不许开工。先提请决策。");
    }
  }

  db.prepare("UPDATE cards SET status=?, updated_at=? WHERE id=?").run(next, nowIso(), c.id);
  logCard(c.id, b.actor || c.owner, `状态 → ${STATUS_LABEL[next]}`, b.note || null);
  json(res, 200, { ok: true });
});

// 提请决策：给这张卡开一个决策包骨架（5 问必填，先把空格留给提议的人填）
route("POST", "/api/cards/:id/request-decision", async (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  const b = await readBody(req);
  for (const k of ["question", "recommendation", "cost", "scope", "silent_default"]) {
    if (!b[k] || !String(b[k]).trim()) return fail(res, 400, `缺字段：${k}（决策包 5 问一个都不能空）`);
  }
  const info = db.prepare(`INSERT INTO decisions
    (question,recommendation,cost,scope,silent_default,answer,condition,asked_by,card_id,created_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.question, b.recommendation, b.cost, b.scope, b.silent_default,
    null, null, b.asked_by || c.owner, c.id, nowIso(), null
  );
  const id = Number(info.lastInsertRowid);
  db.prepare("UPDATE cards SET decision_id=?, updated_at=? WHERE id=?").run(id, nowIso(), c.id);
  logCard(c.id, b.asked_by || c.owner, "提请决策", `决策包 #${id}：${b.question}`);
  json(res, 201, { ok: true, decision_id: id });
});

// 验收：交的和验的分开，同一个人不许自验
// 交活：执行的人（Agent 或你）把产出物登记上，卡进「待验收」
route("POST", "/api/cards/:id/submit", async (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  if (["done", "cancelled"].includes(c.status)) return fail(res, 409, "这张卡已经结束了");
  const b = await readBody(req);
  const by = b.by || c.owner;
  const note = String(b.note || "").trim();
  const evidence = String(b.evidence || "").trim();   // 文件路径 / 链接 / 数据出处
  if (!note) return fail(res, 400, "交活必须写清楚交了什么（note）");
  if (!evidence) return fail(res, 400, "交活必须留证据（evidence：文件路径或链接）");

  const t = nowIso();
  db.prepare("UPDATE cards SET status='review', updated_at=? WHERE id=? AND status NOT IN ('done','cancelled')").run(t, c.id);
  logCard(c.id, by, "交活", `${note}｜证据：${evidence}`);
  json(res, 201, { ok: true, status: "review", card_id: c.id, verifier_needed: true });
});

// 一张卡的全过程（谁开的、谁交的、验没验、卡在哪）
route("GET", "/api/cards/:id/trail", (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  const logs = db.prepare("SELECT at, actor, action, note FROM card_log WHERE card_id = ? ORDER BY id").all(c.id);
  json(res, 200, { card: c, trail: logs });
});

route("POST", "/api/cards/:id/verdict", async (req, res, p) => {
  const c = Q.card.get(Number(p.id));
  if (!c) return fail(res, 404, "卡不存在");
  const b = await readBody(req);
  const verifier = b.verifier || "ceo";
  if (c.status !== "review") return fail(res, 409, "只有「待验收」的卡能验收");
  if (verifier === c.owner) return fail(res, 403, "交的和验的分开：验收人不能是自己");
  const pass = b.verdict === "pass";
  db.prepare("UPDATE cards SET status=?, verdict=?, updated_at=? WHERE id=?")
    .run(pass ? "done" : "doing", pass ? "pass" : "fail", nowIso(), c.id);
  logCard(c.id, verifier, pass ? "验收通过" : "验收不过，退回重做", b.note || `判据：${c.done_def}`);
  json(res, 200, { ok: true, status: pass ? "done" : "doing" });
});

// 开决策包
route("POST", "/api/decisions", async (req, res) => {
  const b = await readBody(req);
  for (const k of ["question", "recommendation", "cost", "scope", "silent_default"]) {
    if (!b[k] || !String(b[k]).trim()) return fail(res, 400, `缺字段：${k}（决策包 5 问一个都不能空）`);
  }
  const info = db.prepare(`INSERT INTO decisions
    (question,recommendation,cost,scope,silent_default,answer,condition,asked_by,card_id,created_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.question, b.recommendation, b.cost, b.scope, b.silent_default,
    null, null, b.asked_by || "ceo", b.card_id ?? null, nowIso(), null
  );
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

// 决定库检索：提建议前先翻以前怎么定的
route("GET", "/api/decisions/search", (req, res) => {
  const url = new URL(req.url, "http://x");
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return fail(res, 400, "缺查询词 q");
  json(res, 200, { q, hits: searchDecisions(q) });
});

// 我回：四种口径之一
route("POST", "/api/decisions/:id/answer", async (req, res, p) => {
  const d = Q.decision.get(Number(p.id));
  if (!d) return fail(res, 404, "决策包不存在");
  const b = await readBody(req);
  const allowed = ["agree", "conditional", "reject", "defer"];
  if (!allowed.includes(b.answer)) return fail(res, 400, `answer 只能是 ${allowed.join(" / ")}`);
  if (b.answer === "conditional" && !b.condition) return fail(res, 400, "附条件同意必须写条件");
  db.prepare("UPDATE decisions SET answer=?, condition=?, decided_at=? WHERE id=?")
    .run(b.answer, b.condition || null, nowIso(), d.id);
  json(res, 200, { ok: true });
});

// ── 千川投流：计划快照 + 建议 ───────────────────────────────
route("POST", "/api/tc/bulk", async (req, res) => {
  const b = await readBody(req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const snap = b.snapshot || null;
  if (!rows.length) return fail(res, 400, "缺 rows");
  const at = nowIso();
  const st = db.prepare(
    `INSERT INTO tc_ads (ad_id,name,status,budget,roi_goal,mar_goal,adlab_mode,learning,cost,gmv,orders,cost_per_order,roi,raw,at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ad_id) DO UPDATE SET
       name=excluded.name,status=excluded.status,budget=excluded.budget,roi_goal=excluded.roi_goal,
       learning=excluded.learning,cost=excluded.cost,gmv=excluded.gmv,orders=excluded.orders,
       cost_per_order=excluded.cost_per_order,roi=excluded.roi,raw=excluded.raw,at=excluded.at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!r.ad_id) continue;
      st.run(String(r.ad_id), r.name || null, r.status || null, r.budget ?? null, r.roi_goal ?? null,
        r.mar_goal ?? null, r.adlab_mode ?? null, r.learning ?? 0,
        r.cost ?? 0, r.gmv ?? 0, r.orders ?? 0, r.cost_per_order ?? null, r.roi ?? null,
        r.raw || null, r.at || at);
      n++;
    }
    if (snap) {
      db.prepare(
        `INSERT INTO tc_snapshot (at,balance,budget,cost_today,gmv_today,roi_today,orders_today,plans,payload)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(at, snap.balance ?? null, snap.accountBudget ?? null, snap.costToday ?? null, snap.gmvToday ?? null,
        snap.roiToday ?? null, snap.ordersToday ?? null, snap.plans ?? null, JSON.stringify(snap).slice(0, 4000));
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return fail(res, 500, "写千川数据失败：" + String(e.message).slice(0, 120)); }
  json(res, 200, { ok: true, written: n });
});

route("GET", "/api/tc", (req, res) => {
  const snap = db.prepare("SELECT * FROM tc_snapshot ORDER BY id DESC LIMIT 1").get() || null;
  const ads = db.prepare("SELECT * FROM tc_ads ORDER BY COALESCE(cost,0) DESC, ad_id").all();
  const advice = db.prepare(
    "SELECT * FROM tc_advice WHERE status != 'dropped' ORDER BY id DESC LIMIT 100"
  ).all();
  const materials = db.prepare("SELECT * FROM tc_materials ORDER BY COALESCE(cost,0) DESC, audit ASC, item_id LIMIT 200").all();
  const byAction = {};
  for (const a of advice) (byAction[a.action] ||= []).push(a);
  json(res, 200, { snapshot: snap, ads, advice, materials, by_action: byAction, total: ads.length });
});

route("POST", "/api/tc/materials/bulk", async (req, res) => {
  const b = await readBody(req);
  const rows = Array.isArray(b.materials) ? b.materials : [];
  if (!rows.length) return fail(res, 400, "缺 materials");
  const at = nowIso();
  const st = db.prepare(
    `INSERT INTO tc_materials (item_id,title,duration,audit,delivery,low_eff,high_q,improvable,cost,roi,ctr,cvr,stats,raw,at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET
       title=excluded.title,duration=excluded.duration,audit=excluded.audit,delivery=excluded.delivery,
       low_eff=excluded.low_eff,high_q=excluded.high_q,improvable=excluded.improvable,
       cost=excluded.cost,roi=excluded.roi,ctr=excluded.ctr,cvr=excluded.cvr,
       stats=excluded.stats,raw=excluded.raw,at=excluded.at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!r.item_id) continue;
      st.run(String(r.item_id), r.title || null, r.duration ?? null, r.audit ?? null, r.delivery ?? null,
        r.low_eff ?? 0, r.high_q ?? 0, r.improvable ?? 0,
        r.cost ?? null, r.roi ?? null, r.ctr ?? null, r.cvr ?? null,
        r.stats || null, r.raw || null, r.at || at);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return fail(res, 500, "写素材失败：" + String(e.message).slice(0, 120)); }
  json(res, 200, { ok: true, written: n });
});

route("POST", "/api/tc/advice", async (req, res) => {
  const b = await readBody(req);
  if (!b.ad_id || !b.action) return fail(res, 400, "缺 ad_id / action");
  const info = db.prepare(
    `INSERT INTO tc_advice (ad_id,ad_name,action,level,reason,numbers,decision_id,status,at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(String(b.ad_id), b.ad_name || null, b.action, b.level || "P1", b.reason || null,
    b.numbers ? JSON.stringify(b.numbers) : null, b.decision_id ?? null, b.status || "open", nowIso());
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

// ── 市场采集（精选联盟爆款榜 / 电商罗盘）─────────────────
route("POST", "/api/market/bulk", async (req, res) => {
  const b = await readBody(req);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, "缺 items");
  const at = nowIso();
  const st = db.prepare(
    `INSERT INTO market_items (source,category,rank_window,title,price,sales_2h,commission_rate,shop,item_id,raw,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source,item_id,title) DO UPDATE SET
       price=excluded.price, sales_2h=excluded.sales_2h, commission_rate=excluded.commission_rate,
       rank_window=excluded.rank_window, fetched_at=excluded.fetched_at`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const it of items) {
      if (!it.title) continue;
      st.run(it.source || "未知", it.category || null, it.rank_window || null, String(it.title).slice(0, 200),
        it.price ?? null, it.sales_2h ?? null, it.commission_rate ?? null, it.shop || null,
        it.item_id || null, it.raw || null, it.fetched_at || at);
      n++;
    }
    // 同一商品会因标题微调（平台加角标/改促销语）产生第二行，UNIQUE 带 title 拦不住。
    // 按 (source,item_id) 只留最新一行，避免市场表越跑越肿、卡片取到旧口径的行。
    const touched = [...new Set(items.map((x) => x.source || "未知"))];
    for (const s of touched) {
      db.prepare(
        `DELETE FROM market_items WHERE source = ? AND id NOT IN (
           SELECT MAX(id) FROM market_items WHERE source = ? GROUP BY item_id
         )`
      ).run(s, s);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return fail(res, 500, "写市场数据失败：" + String(e.message).slice(0, 120)); }
  json(res, 200, { ok: true, written: n });
});

// 触发采集（前端按钮点这个）
// 2026-11-17：界面上的「③ 抓电商罗盘」原来传 source=compass-hot，但连接器早就拆成
// 类目挖掘 + 商品榜单两个了，点一下就 404。这里保留别名，一个按钮跑两条。
const COLLECT_ALIAS = { "compass-hot": ["compass-cate-mining", "compass-rank-goods"] };

route("POST", "/api/market/collect", async (req, res) => {
  const b = await readBody(req);
  const source = String(b.source || "buyin-hot");
  const category = String(b.category || "食品饮料");

  const cf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "connectors.json"), "utf8"));
  const ids = COLLECT_ALIAS[source] || [source];
  const missing = ids.filter((id) => !(cf.connectors || []).some((x) => x.id === id));
  if (missing.length) return fail(res, 404, `没有这个采集源：${missing.join(" / ")}`);

  // 全类目榜不能被界面上的「类目」输入框覆盖掉
  const FIXED = { "buyin-hot-all": { category: "全类目" } };
  cf.connectors = cf.connectors.map((x) =>
    ids.includes(x.id) ? { ...x, enabled: true, ...(FIXED[x.id] || { category }) } : x
  );
  fs.writeFileSync(path.join(import.meta.dirname, "connectors.json"), JSON.stringify(cf, null, 2) + "\n");

  const { spawn } = await import("node:child_process");
  const log = fs.openSync(path.join(import.meta.dirname, "logs", "collect.log"), "a");
  const child = spawn(process.execPath, ["sync.mjs", ...ids], {
    cwd: import.meta.dirname, detached: true, stdio: ["ignore", log, log], windowsHide: true,
  });
  child.unref();
  json(res, 202, { ok: true, started: true, source, ran: ids, category, note: "浏览器会弹出来，采集完自己关；结果去 /api/market 看" });
});

// 精选联盟的真实类目树（连接器每次跑完从接口落一份到 data/buyin-cates.json，
// 界面下拉直接读它 —— 不给用户一个「自己猜类目名」的输入框）
route("GET", "/api/market/cates", (req, res) => {
  const p = path.join(import.meta.dirname, "data", "buyin-cates.json");
  let file = null;
  try { file = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  if (!file) {
    return json(res, 200, {
      ok: false, at: null, list: [], current: "",
      note: "还没有类目树：先跑 node login.mjs --site buyin 再 node sync.mjs buyin-hot-all",
    });
  }
  // 当前配置里那个类目（连接器 buyin-hot 的 category），前端默认选中它
  let current = "";
  try {
    const cf = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "connectors.json"), "utf8"));
    const c = (cf.connectors || []).find((x) => x.id === "buyin-hot");
    if (c && c.category && !/^全类目$/.test(c.category)) current = c.category;
  } catch {}
  json(res, 200, { ok: true, at: file.at, list: file.list || [], current, note: "来自精选联盟联盟榜单接口，不是手写清单" });
});

route("GET", "/api/market", (req, res) => {  const u = new URL(req.url, "http://x");
  const cat = u.searchParams.get("category");
  const src = u.searchParams.get("source");
  let sql = "SELECT * FROM market_items WHERE 1=1";
  const args = [];
  if (cat) { sql += " AND category = ?"; args.push(cat); }
  if (src) { sql += " AND source = ?"; args.push(src); }
  sql += " ORDER BY COALESCE(sales_2h,0) DESC, id DESC LIMIT 300";
  const rows = db.prepare(sql).all(...args);
  const cats = db.prepare("SELECT category, COUNT(*) n FROM market_items GROUP BY category").all();
  const srcs = db.prepare("SELECT source, COUNT(*) n, MAX(fetched_at) at FROM market_items GROUP BY source").all();
  json(res, 200, { items: rows, total: rows.length, categories: cats, sources: srcs });
});

// ── 选品流水线 ─────────────────────────────────────────
// 候选 → CEO审核 → 等你确认 → 做素材 → 草稿箱 → 等货源成本 → 可上架 → 已上架 → 投流
const PIPE_ORDER = ["candidate", "ceo_review", "owner_confirm", "approved", "assets_ready", "cost_pending", "ready", "listed", "ads_on"];

route("GET", "/api/pipeline", (req, res) => {
  const rows = db.prepare("SELECT * FROM product_pipeline ORDER BY id DESC").all();
  const by = {};
  for (const r of rows) (by[r.stage] ||= []).push(r);
  json(res, 200, { items: rows, stages: PIPE_ORDER, by_stage: by, total: rows.length });
});

route("POST", "/api/pipeline", async (req, res) => {
  const b = await readBody(req);
  for (const k of ["shop", "name"]) if (!b[k]) return fail(res, 400, "缺字段：" + k);
  const t = nowIso();
  const info = db.prepare(
    `INSERT INTO product_pipeline (shop,stage,name,category,spec_idea,price_idea,cost_idea,evidence,score,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.shop, b.stage || "candidate", b.name, b.category || null, b.spec_idea || null,
    b.price_idea ?? null, b.cost_idea ?? null, b.evidence ? JSON.stringify(b.evidence) : null,
    b.score ?? null, t, t);
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

// 推进阶段（CEO 判断 / 你确认 / 素材就绪 都走这里）
route("POST", "/api/pipeline/:id/stage", async (req, res, p) => {
  const row = db.prepare("SELECT * FROM product_pipeline WHERE id = ?").get(Number(p.id));
  if (!row) return fail(res, 404, "这条选品不存在");
  const b = await readBody(req);
  const next = String(b.stage || "");
  const allowed = [...PIPE_ORDER, "rejected"];
  if (!allowed.includes(next)) return fail(res, 400, "stage 只能是 " + allowed.join(" / "));

  // 硬规则：没人确认过，不许进「已批准」以后
  if (PIPE_ORDER.indexOf(next) >= PIPE_ORDER.indexOf("approved") && row.owner_answer !== "yes" && next !== "rejected") {
    return fail(res, 403, "你还没确认上这个品（owner_answer=yes），不能往下走");
  }
  // 硬规则：CEO 没审过，不许到你桌上
  if (next === "owner_confirm" && !row.ceo_verdict && !b.ceo_verdict) {
    return fail(res, 409, "CEO 还没审（ceo_verdict 为空），不能直接到你面前");
  }
  // 硬规则：没填成本，不许上架
  if (next === "listed" && !row.cost_json) {
    return fail(res, 409, "SKU 拿货价还没填（cost_json），不能上架");
  }

  const patch = { stage: next, updated_at: nowIso() };
  if (b.ceo_verdict) patch.ceo_verdict = b.ceo_verdict;
  if (b.ceo_reason) patch.ceo_reason = b.ceo_reason;
  if (b.owner_answer) patch.owner_answer = b.owner_answer;
  if (b.owner_note) patch.owner_note = b.owner_note;
  if (b.item_id) patch.item_id = b.item_id;
  if (b.copy_file) patch.copy_file = b.copy_file;
  if (b.images_json) patch.images_json = JSON.stringify(b.images_json);
  if (b.sku_json) patch.sku_json = JSON.stringify(b.sku_json);

  const cols = Object.keys(patch);
  db.prepare(`UPDATE product_pipeline SET ${cols.map((c) => c + "=?").join(",")} WHERE id=?`)
    .run(...cols.map((c) => patch[c]), row.id);
  json(res, 200, { ok: true, id: row.id, stage: next });
});

// 你填 SKU 拿货价 → 自动进「可上架」
route("POST", "/api/pipeline/:id/cost", async (req, res, p) => {
  const row = db.prepare("SELECT * FROM product_pipeline WHERE id = ?").get(Number(p.id));
  if (!row) return fail(res, 404, "这条选品不存在");
  const b = await readBody(req);
  const costs = b.costs;
  if (!costs || typeof costs !== "object" || !Object.keys(costs).length) {
    return fail(res, 400, "costs 必须是 { 规格: 拿货价 } 这样的对象");
  }
  const t = nowIso();
  db.prepare("UPDATE product_pipeline SET cost_json=?, stage=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(costs), "ready", t, row.id);
  json(res, 200, { ok: true, stage: "ready", note: "成本已记录，可以上架了" });
});

// ── 授权矩阵：一类任务只问一次，之后按你定的模式自动走 ──────────
route("GET", "/api/policies", (req, res) => {
  const rows = db.prepare("SELECT * FROM task_policies ORDER BY decided_at DESC").all();
  json(res, 200, { policies: rows, total: rows.length });
});

route("POST", "/api/policies", async (req, res) => {
  const b = await readBody(req);
  const category = String(b.category || "").trim();
  const mode = String(b.mode || "").trim();
  if (!category) return fail(res, 400, "缺字段：category");
  if (!["auto", "human", "ask"].includes(mode)) return fail(res, 400, "mode 只能是 auto / human / ask");

  const t = nowIso();
  db.prepare(
    `INSERT INTO task_policies (category,mode,decided_by,note,decided_at) VALUES (?,?,?,?,?)
     ON CONFLICT(category) DO UPDATE SET mode=excluded.mode, decided_by=excluded.decided_by,
       note=excluded.note, decided_at=excluded.decided_at`
  ).run(category, mode, b.by || "S", b.note || "", t);

  // 顺手把这一类还挂着的授权请求结掉，免得一直躺在决策里
  const pending = db.prepare("SELECT id FROM decisions WHERE answer IS NULL AND scope LIKE ?").all(`%policy:${category}%`);
  for (const d of pending) {
    db.prepare("UPDATE decisions SET answer=?, condition=?, decided_at=? WHERE id=?")
      .run("agree", `授权模式 = ${mode}`, t, d.id);
  }

  // 这一类下面的卡，下一步立刻改口径
  const cards = db.prepare("SELECT id,title FROM cards WHERE status NOT IN ('done','cancelled')").all();
  let touched = 0;
  for (const c of cards) {
    if (!String(c.title).includes(category) && !new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, "\\// 写判据：上架前先写标准")).test(c.title)) {
      // 标题不含类别名时，用关键词粗匹配由 worker 下一轮处理
    }
    touched++;
  }

  json(res, 201, { ok: true, category, mode, closed_decisions: pending.length, cards_seen: touched });
});

// 写判据：上架前先写标准
route("POST", "/api/criteria", async (req, res) => {
  const b = await readBody(req);
  for (const k of ["batch", "metric", "read_day", "rules"]) {
    if (b[k] == null) return fail(res, 400, `缺字段：${k}`);
  }
  if (!Array.isArray(b.rules) || b.rules.length < 2) return fail(res, 400, "判据至少两档（成 / 不成），中间档可选");
  const t = nowIso();
  const info = db.prepare(`INSERT INTO criteria
    (batch,metric,read_day,rules_json,created_day,value,verdict,evaluated_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    b.batch, b.metric, Number(b.read_day), JSON.stringify(b.rules), today(), null, null, null, t
  );
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

// 到点读数：没到那天不许读（不提前找理由）
route("POST", "/api/criteria/:id/evaluate", async (req, res, p) => {
  const k = Q.criterion.get(Number(p.id));
  if (!k) return fail(res, 404, "判据不存在");
  const b = await readBody(req);
  const gap = dayGap(k.created_day);
  if (gap < k.read_day) {
    return fail(res, 409, `还没到第 ${k.read_day} 天（现在是第 ${gap} 天），不提前找理由。`);
  }
  const value = Number(b.value);
  if (!Number.isFinite(value)) return fail(res, 400, "value 必须是数字");
  const rules = JSON.parse(k.rules_json);
  const verdict = applyRules(rules, value);
  db.prepare("UPDATE criteria SET value=?, verdict=?, evaluated_at=? WHERE id=?")
    .run(value, verdict, nowIso(), k.id);
  json(res, 200, { ok: true, verdict });
});

// 早报：治理侧由台账规则生成（source=ledger）；平台侧由数据底座推进来（source=platform）
route("POST", "/api/briefs/generate", (req, res) => {
  const b = generateBrief();
  json(res, 201, { ok: true, ...b });
});

route("POST", "/api/briefs", async (req, res) => {
  const b = await readBody(req);
  if (!b.headline) return fail(res, 400, "缺字段：headline");
  if (!Array.isArray(b.items) || !b.items.length) return fail(res, 400, "items 不能为空");
  for (const i of b.items) {
    if (!i.label || !i.text) return fail(res, 400, "每条 items 必须有 label 和 text");
  }
  const info = db.prepare("INSERT INTO briefs (day,headline,items_json,suggestion,source,created_at) VALUES (?,?,?,?,?,?)")
    .run(b.day || today(), b.headline, JSON.stringify(b.items), b.suggestion || null, b.source || "platform", nowIso());
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

// ---------- Agent 在岗 / 排班 / 汇报 ----------

// 心跳：Agent 每次干完活叫一次，更新在岗灯、主指标、下次排班
route("POST", "/api/agents/:id/heartbeat", async (req, res, p) => {
  const a = Q.agent.get(p.id);
  if (!a) return fail(res, 404, "没有这个 Agent");
  const b = await readBody(req);
  const t = nowIso();
  const next = b.next_run_at ?? a.next_run_at;
  db.prepare(`UPDATE agents SET alive=?, last_run_at=?, next_run_at=?,
              metric_label=COALESCE(?,metric_label), metric_value=COALESCE(?,metric_value),
              metric_extra=COALESCE(?,metric_extra) WHERE id=?`)
    .run(b.alive === false ? 0 : 1, t, next,
      b.metric_label ?? null, b.metric_value != null ? String(b.metric_value) : null, b.metric_extra ?? null, a.id);
  json(res, 200, { ok: true, last_run_at: t });
});

// 排班：这个 Agent 每天几点干什么
route("POST", "/api/agents/:id/schedule", async (req, res, p) => {
  const a = Q.agent.get(p.id);
  if (!a) return fail(res, 404, "没有这个 Agent");
  const b = await readBody(req);
  if (!Array.isArray(b.shift) || !b.shift.length) return fail(res, 400, "shift 必须是 [{at:'08:05',do:'看订单'}] 这样的数组");
  for (const s of b.shift) if (!s.at || !s.do) return fail(res, 400, "每条 shift 必须有 at 和 do");
  db.prepare("UPDATE agents SET shift_json=? WHERE id=?").run(JSON.stringify(b.shift), a.id);
  json(res, 200, { ok: true, shift: b.shift });
});

// 汇报：业务 Agent 往 CEO 桌上放一条
route("POST", "/api/reports", async (req, res) => {
  const b = await readBody(req);
  if (!b.agent_id) return fail(res, 400, "缺字段：agent_id");
  if (!b.summary || !String(b.summary).trim()) {
    return fail(res, 400, "缺字段：summary —— 一句话说清「今天干了什么、卡在哪」");
  }
  if (!Q.agent.get(b.agent_id)) return fail(res, 404, "没有这个 Agent");
  const t = nowIso();
  const info = db.prepare("INSERT INTO reports (agent_id,day,summary,payload_json,created_at) VALUES (?,?,?,?,?)")
    .run(b.agent_id, b.day || today(), b.summary,
      b.payload ? JSON.stringify(b.payload) : null, t);
  db.prepare("UPDATE agents SET alive=1, last_run_at=? WHERE id=?").run(t, b.agent_id);
  json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
});

route("GET", "/api/reports", (req, res) => {
  const url = new URL(req.url, "http://x");
  const agent = url.searchParams.get("agent");
  const limit = Number(url.searchParams.get("limit") || 20);
  json(res, 200, { reports: agent ? Q.reportsBy.all(agent, limit) : Q.reports.all(limit) });
});

// ---------- CEO 巡视：一轮 = 把该催的催了、该报的报上来 ----------
route("POST", "/api/patrol", (req, res) => {
  const sw = sweep();
  const actions = [];

  for (const x of sw.overdue) {
    logCard(x.id, "ceo", "催办", `第 ${x.gap} 天仍未动，约定第 ${x.check_day} 天`);
    actions.push({ kind: "催办", card_id: x.id, note: x.title });
  }
  for (const x of sw.stuck) {
    actions.push({ kind: "上报", card_id: x.id, note: `卡住：${x.title}` });
  }
  for (const x of sw.need_decision || []) {
    actions.push({ kind: "上报", card_id: x.id, note: `P0 欠决策：${x.title}` });
  }
  for (const x of sw.unverified) {
    actions.push({ kind: "待你验收", card_id: x.id, note: x.title });
  }
  // 今天还没汇报的 Agent，催一次
  const d = today();
  for (const a of Q.agents.all()) {
    if (a.id === "S" || a.id === "ceo") continue;
    const r = db.prepare("SELECT COUNT(*) c FROM reports WHERE agent_id=? AND day=?").get(a.id, d);
    if (!r.c) actions.push({ kind: "催汇报", agent_id: a.id, note: `${a.name} 今天还没汇报` });
  }

  const round = patrolStats().today_rounds + 1;
  db.prepare("INSERT INTO patrols (at,round_no,actions_json,created_at) VALUES (?,?,?,?)")
    .run(nowIso(), round, JSON.stringify(actions), nowIso());
  db.prepare("UPDATE agents SET alive=1, last_run_at=? WHERE id='ceo'").run(nowIso());

  json(res, 201, { ok: true, round, actions, sweep: sw });
});

route("GET", "/api/patrols", (req, res) => {
  const url = new URL(req.url, "http://x");
  const limit = Number(url.searchParams.get("limit") || 10);
  json(res, 200, {
    stats: patrolStats(),
    rounds: Q.patrols.all(limit).map((p) => ({ ...p, actions: JSON.parse(p.actions_json) })),
  });
});

// ---------- 知识沉淀：把做完的事落成条目（每晚跑一次） ----------
route("POST", "/api/kb/absorb", async (req, res) => {
  const b = await readBody(req);
  const dept = b.dept || null;
  const d = b.day || today();

  // 取「验收通过 + 今天之前或当天更新」的卡；同卡已入过就跳过（幂等）
  const rows = db.prepare(`SELECT * FROM cards
      WHERE verdict='pass' AND status='done'
        AND (updated_at LIKE ? )
        AND (? IS NULL OR owner = ?)`).all(d + "%", dept, dept);

  let added = 0, skipped = 0;
  for (const c of rows) {
    const dup = db.prepare("SELECT id FROM kb_entries WHERE source_card_id=?").get(c.id);
    if (dup) { skipped++; continue; }
    const dec = c.decision_id ? Q.decision.get(c.decision_id) : null;
    const body = [
      `做了什么：${c.deliverable}`,
      `怎么算完成：${c.done_def}`,
      `为什么做：${c.why}`,
      dec ? `当时批的条件：${dec.condition || S_LABEL(dec)}` : null,
      dec ? `代价：${dec.cost}` : null,
      `范围：${dec ? dec.scope : "未走决策包（P1 以下）"}`,
    ].filter(Boolean).join("\n");
    db.prepare("INSERT INTO kb_entries (dept,title,body,source_card_id,created_at) VALUES (?,?,?,?,?)")
      .run(c.owner, c.title, body, c.id, nowIso());
    added++;
  }
  json(res, 201, { ok: true, day: d, dept, added, skipped });
});

function S_LABEL(dec) {
  return { agree: "同意", conditional: "附条件同意", reject: "不同意", defer: "另定" }[dec.answer] || dec.answer;
}

// Agent 自己往知识库写结论（不是流水账：结论 + 判据 + 代价）
route("POST", "/api/kb", async (req, res) => {
  const b = await readBody(req);
  const dept = String(b.dept || "").trim();
  const title = String(b.title || "").trim();
  const body = String(b.body || "").trim();
  if (!dept || !title || !body) return fail(res, 400, "缺字段：dept / title / body");
  // 同一天同标题只留一条，避免每小时刷一条重复
  const dup = db.prepare("SELECT id FROM kb_entries WHERE dept=? AND title=?").get(dept, title);
  if (dup) {
    db.prepare("UPDATE kb_entries SET body=?, created_at=? WHERE id=?").run(body, nowIso(), dup.id);
    return json(res, 200, { ok: true, id: dup.id, updated: true });
  }
  const r = db.prepare("INSERT INTO kb_entries (dept,title,body,source_card_id,created_at) VALUES (?,?,?,?,?)")
    .run(dept, title, body, null, nowIso());
  json(res, 200, { ok: true, id: r.lastInsertRowid, updated: false });
});

route("GET", "/api/kb", (req, res) => {
  const url = new URL(req.url, "http://x");
  const dept = url.searchParams.get("dept");
  const limit = Number(url.searchParams.get("limit") || 30);
  json(res, 200, {
    count: Q.kbCount.get().c,
    entries: dept ? Q.kbByDept.all(dept, limit) : Q.kb.all(limit),
  });
});

// 活动流：台账日志 + Agent 汇报 + 巡视轮次，混成一条时间线
route("GET", "/api/activity", (req, res) => {
  const url = new URL(req.url, "http://x");
  const limit = Number(url.searchParams.get("limit") || 30);
  const items = [];

  for (const l of Q.allLogs.all(limit * 2)) {
    const c = Q.card.get(l.card_id);
    items.push({
      at: l.at, kind: "cards", tag: c ? c.level : "—",
      title: c ? c.title : `卡 #${l.card_id}`,
      text: `${l.actor} · ${l.action}${l.note ? "：" + l.note : ""}`,
    });
  }
  for (const r of Q.allReports.all(limit)) {
    const a = Q.agent.get(r.agent_id);
    items.push({
      at: r.created_at, kind: "reports", tag: a ? a.name : r.agent_id,
      title: `${a ? a.name : r.agent_id} 汇报`,
      text: r.summary,
    });
  }
  for (const p of Q.patrols.all(limit)) {
    const acts = JSON.parse(p.actions_json) || [];
    items.push({
      at: p.at, kind: "patrols", tag: "CEO",
      title: `第 ${p.round_no} 轮巡视 · 出手 ${acts.length} 次`,
      text: acts.length ? acts.map((a) => a.kind + "「" + a.note + "」").join("；") : "没有该催的、没有该报的",
    });
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  json(res, 200, { items: items.slice(0, limit) });
});

// 导出全量（喂给别的 Agent / 存进知识库）
route("GET", "/api/export", (req, res) => {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="ainative-export-${today()}.json"`,
  });
  res.end(JSON.stringify(state(), null, 2));
});

// ---------- 静态 + 启动 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try { await r.handler(req, res, params); }
      catch (e) { fail(res, 500, String(e.message || e)); }
      // 写操作完事后推一次；GET 里 /api/stream 自己会推，不用重复
      if (req.method !== "GET" && pathname !== "/api/stream") kickBroadcast();
      return;
    }
    return fail(res, 404, "没有这个 API");
  }

  const file = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("404");
  }
  // 静态文件不缓存：本地工具天天改，浏览器缓存旧 js 会让人以为改动没生效
  res.writeHead(200, {
    "content-type": MIME[path.extname(full)] || "application/octet-stream",
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI Native 内核跑起来了 → http://127.0.0.1:${PORT}`);
});

// ── 崩溃日志：不留痕就查不出为什么挂 ──────────────────────
const CRASH_LOG = path.join(import.meta.dirname, "logs", "server-crash.log");
function logCrash(tag, err) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    fs.appendFileSync(CRASH_LOG,
      `\n[${new Date().toISOString()}] ${tag}\n${err?.stack || err}\n`, "utf8");
  } catch {}
  console.error(`[${tag}]`, err);
}
process.on("uncaughtException", (e) => {
  logCrash("uncaughtException", e);
  // 单次异常不该让整个服务消失；进程留着，守护脚本也不用重启
});
process.on("unhandledRejection", (e) => logCrash("unhandledRejection", e));
process.on("SIGTERM", () => { logCrash("SIGTERM", new Error("被要求退出")); process.exit(0); });
process.on("exit", (code) => {
  if (code !== 0) logCrash("exit", new Error(`进程退出 code=${code}`));
});
