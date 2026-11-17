/* 指挥台 · AI Native 内核
 * 版式与动效沿用 8899（Paperclip 风格指挥台），但数据全部来自本机后端 /api/state。
 * 与 8899 最大的区别：这里每张卡、每个数字、每个动作都真的会写库，不是 DATA 里的假数。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let S = null;
let D = null;
let PROFILE = {
  org: { name: "AI Native 内核", logo: "AI" },
  owner: { name: "我", initial: "S", role: "创始人 · 拍板定方向" },
};
let currentTab = "overview";
let ACT = [];
let SHOPS = { shops: [], platforms: [] };
const PICKED = new Set();
// 勾选了哪些店铺（批量分析用）
let OSS_CONNS = [];                 // 兼容旧变量名
let ALL_CONNS = [];                 // 全部连接器（按 agent 判断「到底接没接数据源」）
const MASK = { on: localStorage.getItem("ainative.mask") === "1" };

const ICON = { shop: "🛒", content: "▣", pick: "◇", oss: "☆", inv: "↗", kb: "▤", tc: "◈" };
const AVCOLOR = {
  shop: "linear-gradient(160deg,#34D399,#0EA5E9)",
  content: "linear-gradient(160deg,#F472B6,#A855F7)",
  oss: "linear-gradient(160deg,#FBBF24,#F97316)",
  inv: "linear-gradient(160deg,#A78BFA,#6366F1)",
  kb: "linear-gradient(160deg,#22D3EE,#0EA5E9)",
  asst: "linear-gradient(160deg,#FDE047,#F59E0B)",
};

// 时间是 UTC 存的，必须转本地再显示，否则会差 8 小时（之前显示 17:34，实际 01:34）
const hhmm = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};const ddmm = (iso) => (iso ? String(iso).replace("T", " ").slice(5, 10) : "—");
const dayOf = (iso) => (iso ? String(iso).slice(5, 10) : "—");

// 本地时间（后端存 UTC，直接切字符串会差 8 小时）
function localHM(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 悬停详表：三个口径 × 全部指标 ──────────────────────────
// 原生 title 又慢又只能一行，这里自己画黑框，把该店所有指标摊开对比。
const TIP_ORDER = [
  "成交金额", "用户支付金额", "结算金额", "成交订单数", "成交人数", "客单价",
  "商品曝光", "商品点击", "曝光人数",
  "曝点转化率", "点击成交率",
  "投放消耗", "投放费比", "搜索支付金额", "搜索曝光人数",
  "短视频成交", "直播引流成交", "退款金额",
  "待发货", "售后待处理",
  "账户资金", "体验分", "商品分", "物流分", "服务分",
];

function shopTip(s) {
  const wins = ["实时", "近7天", "近30天"].filter((w) => s.windows?.[w]?.metrics);
  if (!wins.length) return null;

  const seen = new Set();
  const labels = [];
  for (const w of wins) {
    for (const v of Object.values(s.windows[w].metrics || {})) {
      if (!v?.label || seen.has(v.label)) continue;
      if (v.value == null || v.value === "") continue;
      seen.add(v.label);
      labels.push(v.label);
    }
  }
  labels.sort((a, b) => {
    const ia = TIP_ORDER.indexOf(a), ib = TIP_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  const cell = (w, label) => {
    const m = Object.values(s.windows[w]?.metrics || {}).find((v) => v.label === label);
    if (!m) return { t: "—", ok: false };
    // 三态：页面为空（值 "-"）算正常但显示 —；只有「页面没这一项」才是未取到
    if (m.value === "-") return { t: "—", ok: true, blank: true, why: m.extra || "页面为空" };
    if (!m.ok) return { t: "未取到", ok: false, why: m.extra || "页面没这一项" };
    if (m.value == null || m.value === "") return { t: "—", ok: true, blank: true };
    let t = String(m.value);
    // 比率类补上百分号，三个窗口口径统一（页面抓来的有的带 % 有的不带）
    if (/率|费比/.test(label) && !t.includes("%")) t = `${t}%`;
    return { t, ok: true };
  };

  const score = cell("实时", "体验分");
  const rows = labels.map((lb) => `<tr><th>${esc(lb)}</th>${
    wins.map((w) => { const c = cell(w, lb); return `<td class="${c.ok ? (c.blank ? "blank" : "") : "dash"}"${c.why ? ` title="${esc(c.why)}"` : ""}>${esc(c.t)}</td>`; }).join("")
  }</tr>`).join("");

  const stamps = wins.map((w) => `<span>${esc(w)} ${esc(localHM(s.windows[w].at))}</span>`).join("");

  return `<div class="tiph">
      <b>${esc(s.platform_name)} · ${esc(s.name)}</b>
      <i class="tbadge ${score.ok ? "ok" : ""}">${score.ok ? `体验分 ${esc(score.t)}` : "体验分 —"}</i>
    </div>
    <table class="tiptb">
      <thead><tr><th>指标</th>${wins.map((w) => `<th>${esc(w)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="tipf">${stamps}<span>口径 ${esc(s.window_label || "实时")}</span></div>`;
}

let TIPEL = null;
function hideTip() { if (TIPEL) TIPEL.style.display = "none"; }
function showTip(html, x, y) {
  if (!TIPEL) {
    TIPEL = document.createElement("div");
    TIPEL.className = "bigtip";
    document.body.appendChild(TIPEL);
  }
  TIPEL.innerHTML = html;
  TIPEL.style.display = "block";
  const r = TIPEL.getBoundingClientRect();
  const pad = 16;
  let left = x + pad, top = y + pad;
  if (left + r.width > window.innerWidth - 10) left = Math.max(10, x - r.width - pad);
  if (top + r.height > window.innerHeight - 10) top = Math.max(10, window.innerHeight - r.height - 10);
  TIPEL.style.left = `${left}px`;
  TIPEL.style.top = `${top}px`;
}

document.addEventListener("mousemove", (e) => {
  const pk = e.target?.closest?.("[data-tippick]");
  if (pk) {
    const inner = pk.querySelector(".tipdata");
    if (inner) { showTip(inner.innerHTML, e.clientX, e.clientY); }
    return;
  }
  const el = e.target?.closest?.("[data-tipshop]");
  if (!el) return hideTip();
  const s = (SHOPS.shops || [])[Number(el.dataset.tipshop)];
  const html = s ? shopTip(s) : null;
  if (!html) return hideTip();
  showTip(html, e.clientX, e.clientY);
});
window.addEventListener("scroll", hideTip, true);


// 「几分钟前」——比时间点更直观
function agoCn(iso) {
  if (!iso) return "没跑过";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "没跑过";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 30) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
const stampOf = (iso) => (iso ? `更新 ${localHM(iso)} · ${agoCn(iso)}` : "还没跑过");

function ago(iso) {
  if (!iso) return "—";
  const t = new Date(String(iso).replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return "—";
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

function toast(msg, bad) {
  const d = document.createElement("div");
  d.className = "tm" + (bad ? " bad" : "");
  d.textContent = msg;
  $("#toast").appendChild(d);
  setTimeout(() => d.remove(), 2800);
}

async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ── 真数据 → 视图模型 ─────────────────── */

function urgentItems(st) {
  const sw = st.sweep, out = [];
  (sw.need_decision || []).forEach((x) => out.push({ k: "P0 欠决策", t: x.title, owner: x.owner, kind: "card", id: x.id, why: "没过我的决策包，一步都动不了" }));
  sw.stuck.forEach((x) => out.push({ k: "卡住", t: x.title, owner: x.owner, kind: "card", id: x.id, why: "卡住了，要么给条件要么砍掉" }));
  sw.silent_decisions.forEach((x) => out.push({ k: "没人回", t: x.question, owner: "我", kind: "dec", id: x.id, why: x.silent_default }));
  sw.unverified.forEach((x) => out.push({ k: "待验收", t: x.title, owner: x.owner, kind: "card", id: x.id, why: "交的和验的分开，得我来判" }));
  sw.due_criteria.forEach((x) => out.push({ k: "到点读数", t: x.batch, owner: "判据", kind: "criteria", id: x.id, why: `${x.metric} · 第 ${x.read_day} 天` }));
  sw.overdue.forEach((x) => out.push({ k: "到期没动", t: x.title, owner: x.owner, kind: "card", id: x.id, why: `已过 ${x.gap} 天 / 约定第 ${x.check_day} 天` }));
  return out;
}

function buildD(st, acts) {
  const sw = st.sweep;
  const urgent = urgentItems(st);
  const p = st.patrol || { today_rounds: 0, today_actions: 0, last_at: null, last_actions: [] };
  const pendingDec = st.decisions.filter((d) => d.answer == null);
  // 店铺的 Agent 不进上面那面卡片墙 —— 它们走到「店铺」那一组竖排里去，
  // 免得同一家店在页面上出现两次。顺序上，店铺组紧跟在卡片墙后面。
  const storeAgents = new Set((SHOPS.shops || []).map((s) => s.agent));
  // 下线的 Agent（开源那条数据源一直没通）不再上墙；自动选品常驻
// 卡片顺序按业务链排：先电商（看数据），紧挨着自动选品（找新品），其余在后
const AGENT_ORDER = ["shop", "pick", "tc", "content", "inv", "kb"];
const agents = st.agents
  .filter((a) => !["S", "ceo"].includes(a.id)
    && !storeAgents.has(a.id)
    && !(a.id === "oss" && !a.alive))
  .sort((x, y) => {
    const ix = AGENT_ORDER.indexOf(x.id);
    const iy = AGENT_ORDER.indexOf(y.id);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
  const ceo = st.agents.find((a) => a.id === "ceo") || {};
  const lastRep = (st.reports || [])[0];

  return {
    tabs: [
      { id: "overview", label: "总览" },
      { id: "brief", label: "早报" },
      { id: "tasks", label: "台账" },
      { id: "approvals", label: "决策", badge: pendingDec.length || null },
      { id: "criteria", label: "判据" },
      { id: "shops", label: "店铺", badge: (SHOPS.shops || []).length || null },
      { id: "audit", label: "巡检" },
      { id: "pipeline", label: "选品", badge: null },
      { id: "tc", label: "投流", badge: (st.tc_hot || null) },
    { id: "todo", label: "待办", badge: urgent.length || null },
    ],
    org: {
      name: PROFILE.owner.name,
      initial: PROFILE.owner.initial,
      role: PROFILE.owner.role,
      waiting: urgent.length,
      down: {
        title: "拍板 · 定方向",
        detail: `等你 ${urgent.length} 件`,
        extra: urgent[0] ? `${urgent[0].k}：${urgent[0].t}` : "没有积压",
      },
      up: {
        title: "汇报",
        at: lastRep ? hhmm(lastRep.created_at) : hhmm(ceo.last_run_at),
        detail: `今天 ${(st.reports || []).length} 条`,
        extra: (st.reports || []).slice(0, 3).map((r) => hhmm(r.created_at)).join(" / ") || "还没有汇报",
      },
    },
    ceo: {
      name: "CEO Agent",
      tag: "CEO",
      line1: `每小时巡视 · 今天 ${p.today_rounds} 轮 · 出手 ${p.today_actions} 次`,
      line2: `在验收 ${sw.unverified.length} 件 · 上次巡视 ${hhmm(p.last_at)}`,
      detail: [
        ["角色", "CEO · 汇总 / 派活 / 验收 / 催办"],
        ["巡视频率", "每小时 1 轮（接入系统定时任务）"],
        ["今天轮次", `${p.today_rounds} 轮`],
        ["今天出手", `${p.today_actions} 次`],
        ["上一轮动作", p.last_actions?.length ? p.last_actions.map((a) => a.kind).join(" / ") : "没动手"],
        ["直接下属", `${agents.length} 个业务 Agent + ${(SHOPS.shops || []).length} 家店`],
        ["P0 闸门", "大事没过我的决策包，一步都不许动"],
      ],
    },
    agents: agents.map((a) => {
      const rep = a.last_report;
      const open = st.cards.filter((c) => c.owner === a.id && !["done", "cancelled"].includes(c.status));
      const repAt = rep ? hhmm(rep.created_at) : "—";
      const shifts = (a.shift || []).length;

      // 每个 Agent 下面挂它管的子项：
      // 1) 有 submetrics 的（连接器自己写的，一个源一行）优先用
      // 2) 没有就按配置列出来，值写「—」「未接」，不编数
      const subs = (st.submetrics || []).filter((m) => m.agent_id === a.id);
      let children = [];
      // 电商：底下挂的是「店」，不是「连接器」
      if (a.id === "shop" && (SHOPS.shops || []).length) {
        children = SHOPS.shops.map((s, idx) => {
          const short = String(s.platform_name || "").split("/")[0];
          const need = short && !String(s.name).includes(short);

          // 三个时间窗各有一份快照，互不覆盖：卡片显示「今日」，其余放悬停
          const W = s.windows || {};
          const pick = (win, keys) => {
            const m = W[win]?.metrics || {};
            for (const k of keys) {
              if (m[k] && m[k].ok && m[k].value != null && m[k].value !== "") return m[k].value;
            }
            return null;
          };
          // 金额跟随「这家店当前选的窗口」，别永远显示实时
          const winNow = s.window || "实时";
          const GMV = ["shop_demo-gmv", "shop_demo-pay"];
          const gmvLive = pick(winNow, GMV);
          const gmv7 = pick("近7天", GMV);
          const gmv30 = pick("近30天", GMV);
          const score = pick("实时", ["shop_demo-score"]) ?? pick("近7天", ["shop_demo-score"]);
          const sGoods = pick("实时", ["shop_demo-score-goods"]);
          const sLogi = pick("实时", ["shop_demo-score-logi"]);
          const sSvc = pick("实时", ["shop_demo-score-svc"]);
          const views = pick("实时", ["shop_demo-views"]);
          const ctr = pick("实时", ["shop_demo-ctr"]);
          const fund = pick("实时", ["shop_demo-fund"]);
          const after = pick("实时", ["shop_demo-after"]);
          const pend = pick("实时", ["shop_demo-browser"]);

          const tip = [
            `${s.platform_name} · ${s.name}`,
            gmvLive != null ? `${winNow === "实时" ? "今日" : winNow}成交 ¥${gmvLive}` : "成交 没取到",
            gmv7 != null ? `近7天 ¥${gmv7}` : null,
            gmv30 != null ? `近30天 ¥${gmv30}` : null,
            score != null ? `体验分 ${score}（商品 ${sGoods ?? "—"} / 物流 ${sLogi ?? "—"} / 服务 ${sSvc ?? "—"}）` : null,
            views != null ? `曝光 ${views} · 曝点转化 ${ctr != null ? ctr + "%" : "—"}` : null,
            `待发货 ${pend ?? "—"} · 售后 ${after ?? "—"} · 账户资金 ¥${fund ?? "—"}`,
            s.window_at ? `更新 ${localHM(s.window_at)}` : null,
          ].filter(Boolean).join("\n");

          return {
            dot: !!s.alive,
            platform: s.platform_name,
            name: MASK.on ? s.platform_name : need ? `${s.platform_name} · ${s.name}` : s.name,
            value: MASK.on ? "•••" : (gmvLive != null ? `¥${gmvLive}` : (s.metric_value ?? "—")),
            sub: gmvLive != null ? (winNow === "实时" ? "今日成交" : winNow + "成交") : (s.metric_label || ""),
            tipshop: idx,
            when: stampOf(s.last_run_at),
            extras: [
              score != null ? { label: "体验分", value: String(score) } : null,
              gmv7 != null ? { label: "近7天", value: `¥${gmv7}` } : null,
              gmv30 != null ? { label: "近30天", value: `¥${gmv30}` } : null,
            ].filter(Boolean),
          };
        });
      } else if (subs.length) {
        children = subs.map((m) => ({
          name: m.label || m.key,
          value: m.ok && m.value != null ? String(m.value) : "—",
          sub: m.ok ? (m.extra || "已接") : String(m.extra || "失败").slice(0, 14),
          muted: !m.ok,
        }));
      } else if (a.id === "shop") {
        children = (SHOPS.shops || []).map((s) => ({
          name: MASK.on ? s.platform_name : s.name,
          value: MASK.on ? "•••" : s.metric_value,
          sub: s.metric_label,
        }));
      } else if (a.id === "pick") {
        // 每个采集源一行（条数 + 抓取时间）+ 候选池
        const m = a.market || {};
        children = [
          ...(m.sources || []).map((s) => ({
            name: String(s.source).replace("精选联盟·爆款榜", "联盟爆款榜"),
            value: `${s.n} 条`,
            sub: `${localHM(s.at)} 抓`,
            muted: false,
          })),
          { name: "候选池", value: (m.candidates || 0) + " 条",
            sub: m.waiting ? m.waiting + " 条等你确认" : "CEO 审过的会到这", muted: false },
        ];
      } else if (a.id === "kb") {
        children = [
          { name: "知识条目", value: String(st.kb_count), sub: "库内共" },
          { name: "待你拍板", value: String(st.decisions.filter((d) => d.answer == null).length), sub: "决策包" },
        ];
      } else if (a.id === "content") {
        children = ((PROFILE.business || {}).media || []).map((m) => ({
          name: m.name, value: "—", sub: "未接数据源", muted: true,
        }));
      }

      // 边上那两行：往下派什么、往上报什么
      const flow = a.id === "kb"
        ? { down: "每晚沉淀", up: `入库 ${st.kb_count} 条` }
        : a.id === "asst"
          ? { down: "每天巡检", up: `新发现 ${a.metric_value || "—"}` }
          : a.id === "inv"
            ? { down: "不派工", up: `日报 ${repAt}` }
            : a.id === "content"
              ? { down: `采集 ${shifts || 1} 次/天`, up: `汇报 ${repAt}` }
              : { down: `手上 ${open.length} 件`, up: `日报 ${repAt}` };

      return {
        id: a.id,
        icon: ICON[a.id] || "◆",
        name: a.name,
        // 灯要看真话：
        //   灰 = 没有已启用的数据源（含「配了但没开」「没凭证」）
        //   黄 = 有数据源，但最近一次没成功
        //   绿 = 有数据源且最近一次成功
        status: (() => {
          const myAgents = new Set([...(a.id === "shop" ? (SHOPS.shops || []).map((s) => s.agent) : []), a.id]);
          const active = ALL_CONNS.some((c) => myAgents.has(c.agent) && c.enabled)
            || (SHOPS.shops || []).some((s) => s.agent === a.id);
          if (!active) return "off";
          return a.alive && a.last_run_at ? "ok" : "warn";
        })(),
        hasSource: ALL_CONNS.some((c) => (a.id === "shop" ? (SHOPS.shops || []).some((s) => s.agent === c.agent) : c.agent === a.id) && c.enabled),
        value: a.metric_value || "—",
        unit: "",
        label: a.metric_label || "",
        demo: false,
        prev: hhmm(a.last_run_at),
        // 下次时间已经过去就标逾期，否则一直显示个早过去的钟点，骗人
        next: (() => {
          if (!a.next_run_at) return "—";
          const t = new Date(a.next_run_at).getTime();
          if (!Number.isFinite(t)) return "—";
          const late = Date.now() - t;
          if (late <= 60000) return hhmm(a.next_run_at);
          const h = late / 3600000;
          return `${hhmm(a.next_run_at)}（逾期 ${h >= 1 ? Math.round(h) + "h" : Math.round(late / 60000) + "m"}）`;
        })(),
        overdue: !!a.next_run_at && Number.isFinite(new Date(a.next_run_at).getTime()) && Date.now() - new Date(a.next_run_at).getTime() > 3600000,
        freq: shifts ? `${shifts} 班/天` : "没排班",
        metric_extra: a.metric_extra || "",
        market: a.market || null,          // 选品卡片要按源渲染行，别在这儿丢掉
      note: rep ? `[${localHM(rep.created_at || rep.day)} 汇报] ${rep.summary}` : "今天还没汇报",
        noteErr: !rep,
        edge: { delegated: open.length, report: repAt },
        flow,
        children,
        raw: a,
      };
    }),
    metrics: [
      { id: "open", label: "在办的卡", value: String(st.cards.filter((c) => !["done", "cancelled"].includes(c.status)).length), unit: "件", sub: "台账里没结的", src: "本地 SQLite · /api/state" },
      { id: "stuck", label: "卡住", value: String(sw.stuck.length), unit: "件", sub: "要报给我", src: "本地 SQLite" },
      { id: "review", label: "待验收", value: String(sw.unverified.length), unit: "件", sub: "我来判", src: "本地 SQLite" },
      { id: "duecrit", label: "到点该读数", value: String(sw.due_criteria.length), unit: "个", sub: "判据", src: "本地 SQLite" },
      { id: "needdec", label: "P0 欠决策", value: String((sw.need_decision || []).length), unit: "件", sub: "动不了", src: "本地 SQLite" },
      { id: "silent", label: "没人回", value: String(sw.silent_decisions.length), unit: "件", sub: "默认不做", src: "本地 SQLite" },
      { id: "overdue", label: "到期没动", value: String(sw.overdue.length), unit: "件", sub: "该催", src: "本地 SQLite" },
      { id: "rounds", label: "今天巡视", value: String(p.today_rounds), unit: "轮", sub: "CEO", src: "patrols 表" },
      { id: "hits", label: "今天出手", value: String(p.today_actions), unit: "次", sub: "催办 / 上报", src: "patrols 表" },
      { id: "crit", label: "判据已读", value: `${st.criteria.filter((k) => k.verdict).length}/${st.criteria.length}`, unit: "", sub: "成 / 中间 / 不成", src: "criteria 表" },
      { id: "kb", label: "知识条目", value: String(st.kb_count), unit: "条", sub: "每晚沉淀", src: "kb_entries 表" },
      { id: "lib", label: "决定库", value: String(st.decisions.filter((d) => d.answer).length), unit: "条", sub: "已定的", src: "decisions 表" },
    ],
    todos: urgent,
    footerLeft: `真实数据 · /api/state · 写操作走 6 条服务端硬规则（P0 闸门 / 交验分离 / 未到点不读数）· 没有 DEMO 数据`,
    footerRight: `${st.today} · ${st.agents.filter((a) => a.alive).length}/${st.agents.length} 在岗 · 巡视 ${p.today_rounds} 轮 · ${urgent.length} 件等你`,
    motion: { enabled: true, reportDur: 2.8, delegateDur: 1.6 },
  };
}

/* ── 渲染 ─────────────────────────────── */

function renderTabs() {
  $("#tabs").innerHTML = D.tabs
    .map((t) => `<button class="tab${t.id === currentTab ? " active" : ""}" data-tab="${t.id}">${esc(t.label)}${
      t.badge ? `<span class="badge">${t.badge}</span>` : ""
    }</button>`)
    .join("");
}

function agentCard(a) {
  // 选品 Agent：每个采集源一行（条数 + 抓取时间），悬浮看核心数据，点行直接进明细
  if (a.id === "pick") {
    const m = a.market || {};
    const srcs = m.sources || [];
    const short = (s) => String(s)
      .replace("精选联盟·爆款榜", "联盟爆款榜")
      .replace("罗盘·", "罗盘·");

    const tipRows = srcs.map((s) => {
      const t = s.top || {};
      const isRank = /精选联盟/.test(s.source);
      const hotLine = isRank
        ? `　热销有值 ${s.with_hot}/${s.n}${s.board_total ? ` · 榜单共 ${s.board_total} 条（抓前 ${s.n}）` : ""}`
        : /商品榜单/.test(s.source)
          ? `　榜单商品 ${s.n} 条（价格带 / 成交件数 / 转化率）`
          : `　类目机会 ${s.n} 条（增速 / 需供比 / 价格带）`;
      return `<div class="tr">
        <span class="tk">${esc(short(s.source))}</span>
        <span class="tv">${s.n} 条${s.board_total ? ` / 共 ${s.board_total}` : ""}</span>
        <span class="ts">${esc(stampOf(s.at))}</span>
      </div>${t.title ? `<div class="tn">Top1 ${esc(String(t.title).slice(0, 40))}</div>
      <div class="tn">　${isRank ? `近2小时 ${t.sales_2h ?? "—"} · ¥${t.price ?? "—"} · 佣金 ${t.commission ?? "—"}% · ${esc(t.shop || "")}` : `价格带 ¥${t.price ?? "—"}${t.shop ? " · " + esc(t.shop) : ""}`}</div>` : ""}
      <div class="tn">${hotLine}</div>`;
    }).join("");

    const tipHtml = (tipRows || `<div class="tn">还没有采集数据，去选品页点 ② / ④</div>`)
      + `<div class="tr" style="margin-top:6px"><span class="tk">候选池</span><span class="tv">${m.candidates || 0} 条</span><span class="ts">${m.waiting ? m.waiting + " 条等你确认" : "等 CEO 审"}</span></div>`
      + `<div class="tn" style="margin-top:6px">点上面任意一行 → 进「选品页」并按这个源过滤</div>`;

    const srcList = srcs.map((s) => `<span class="srcrow" data-src="${esc(s.source)}" title="点击进明细">
        <b>${esc(short(s.source))}</b><i>${s.n} 条</i><em>${esc(localHM(s.at))}</em>
      </span>`).join("");

    return `<div class="acard slim pickcard" role="button" tabindex="0" data-open="agent" data-id="${a.id}" data-tippick="1">
      <div class="head"><span class="ico">${a.icon}</span><span class="nm">${esc(a.name)}</span><i class="dot ${a.status}"></i></div>
      <div class="val"><span class="num">${esc(a.value)}</span><span class="unit">${esc(a.label)}</span></div>
      <div class="meta">${esc(a.metric_extra || "")}</div>
      ${srcList ? `<div class="srclist">${srcList}</div>` : ""}
      <div class="tipdata" style="display:none">${tipHtml}</div>
    </div>`;
  }
  return `<button class="acard" data-open="agent" data-id="${a.id}">
    <div class="head"><span class="ico">${a.icon}</span><span class="nm">${esc(a.name)}</span>
      <i class="dot ${a.status}" title="${a.status === "ok" ? "已连数据源，最近一次成功" : a.status === "warn" ? "接了数据源，但最近一次失败" : "还没接数据源"}"></i></div>
    <div class="val"><span class="num">${esc(a.value)}</span>${a.unit ? `<span class="unit">${a.unit}</span>` : ""}
      ${a.demo ? '<span class="demo">DEMO</span>' : ""}<span class="unit">${esc(a.label)}</span></div>
    <div class="meta">上次 <b>${esc(a.prev)}</b> -> 下次 <b class="${a.overdue ? "late" : ""}">${esc(a.next)}</b> · ${esc(a.freq)}</div>
    <div class="det${a.noteErr ? " err" : ""}">${esc(a.note)}</div>
  </button>`;
}

function metricCard(m) {
  return `<button class="mcard" data-open="metric" data-id="${m.id}">
    <div class="top">${esc(m.label)}</div>
    <div class="v"><span class="n">${esc(m.value)}</span>${m.unit ? `<span class="u">${esc(m.unit)}</span>` : ""}</div>
    <div class="sub">${esc(m.sub)}</div>
  </button>`;
}

function renderOverview() {
  const o = D.org;
  return `
  <div class="stage" id="stage">
    <svg id="fan"></svg>

    <div class="human-row">
      <div class="human" data-open="human">
        <div class="avatar">${o.initial}</div>
        <div>
          <div class="name">${esc(o.name)}</div>
          <div class="role">${esc(o.role)}</div>
        </div>
        <div class="wait-pill">等你 ${o.waiting} 件</div>
      </div>
    </div>

    <div class="human-links">
      <div class="hlink" data-open="human-down">
        <div class="row1"><span class="arrow">↓</span>${esc(o.down.title)}</div>
        <div class="row2">${esc(o.down.detail)} · ${esc(o.down.extra)}</div>
      </div>
      <div class="hlink" data-open="human-up">
        <div class="row1"><span class="arrow" style="color:#7FB0FF">↑</span>${esc(o.up.title)}
          <span style="color:var(--fg2);font-variant-numeric:tabular-nums">${esc(o.up.at)}</span></div>
        <div class="row2">${esc(o.up.detail)} · ${esc(o.up.extra)}</div>
      </div>
    </div>

    <div class="ceo-row">
      <div class="ceo" data-open="ceo">
        <div class="radar"></div>
        <div>
          <div class="t">${esc(D.ceo.name)}<span class="tag-ceo">${esc(D.ceo.tag)}</span></div>
          <div class="k">${esc(D.ceo.line1)}</div>
          <div class="s">${esc(D.ceo.line2)}</div>
        </div>
      </div>
    </div>

    <div class="mesh" id="mesh">
      ${D.agents.map((a) => `
        <div class="mcol" data-agent-col="${a.id}">
          <div class="labels">
            <span class="down">↓ ${esc(a.flow.down)}</span>
            <span class="up">↑ ${esc(a.flow.up)}</span>
          </div>
          ${agentCard(a)}
          <div class="children">
            ${(a.children || []).map((c, ci) => `<div class="child${c.muted ? " muted" : ""}${(c.extras || []).length ? " tall" : ""}"${c.tipshop !== undefined ? ` data-tipshop="${ci}"` : ""}>
              <div class="crow">
                ${c.dot !== undefined ? `<i class="dot ${c.dot ? "ok" : "bad"}" style="flex:none"></i>` : ""}
                <span class="cn">${esc(c.name)}</span>
                <span class="cv">${esc(c.value)}</span>
                <span class="cs">${esc(c.sub || "")}</span>
              </div>
              ${(c.extras || []).length ? `<div class="cx">${c.extras.map((e) =>
                `<span>${esc(e.label)} <b>${esc(e.value)}</b></span>`).join("")}
                ${c.when ? `<span class="cw">${esc(c.when)}</span>` : ""}</div>` : ""}
            </div>`).join("") || `<div class="child muted"><span class="cn">未接数据源</span></div>`}
          </div>
        </div>`).join("")}
    </div>
  </div>`;
}

function renderBrief() {
  const b = S.brief;
  if (!b) return `<div class="stage"><div class="empty">还没有早报。去「巡检」页点一次生成。</div></div>`;
  const tone = (t) => (t === "bad" ? "bad" : t === "warn" ? "warn" : "ok");
  return `<div class="stage">
    <div style="display:flex;align-items:flex-end;gap:14px;margin:6px 0 16px">
      <div>
        <div style="font-size:24px;font-weight:800">${esc(b.headline)}</div>
        <div style="color:var(--fg3);font-size:12px;margin-top:5px">
          ${esc(b.day)} · ${b.source === "ledger" ? "台账规则生成" : "数据底座"} · AI 只读，不动店</div>
      </div>
      <div style="margin-left:auto"><button class="btn" data-act="genbrief">重新生成（治理侧）</button></div>
    </div>
    <div class="panel">
      ${b.items.map((i) => `<div class="kv"><span class="k">${esc(i.label)}</span>
        <span class="v" style="display:flex;gap:9px;align-items:center">
          <span class="chip ${tone(i.tone)}">${i.tone === "bad" ? "要看" : i.tone === "warn" ? "注意" : "正常"}</span>
          ${esc(i.text)}</span></div>`).join("")}
    </div>
    <div class="panel" style="margin-top:14px;border-color:rgba(245,165,36,.3);background:rgba(245,165,36,.05)">
      <div class="sec-t" style="margin:0 0 8px">建议</div>
      <div style="font-size:13.5px;line-height:1.7;color:#F3D3A0">${esc(b.suggestion)}</div>
    </div>
    <div style="color:var(--fg3);font-size:11.5px;margin-top:12px">
      治理侧早报只报台账算得出来的事。流量 / 订单 / 评论要接 SP-API + Printful 才有。</div>
  </div>`;
}

const STATUS_COLS = [["todo", "待办"], ["doing", "进行中"], ["review", "待验收"], ["done", "已完成"]];

function tcard(c) {
  const gate = c.gate === "need_decision";
  const canSubmit = ["todo", "doing", "blocked"].includes(c.status);
  const canVerify = c.status === "review";
  const btns = [];
  if (canSubmit) btns.push(`<button class="btn mini" data-submit="${c.id}">交活</button>`);
  if (canVerify) {
    btns.push(`<button class="btn mini ok" data-verdict="pass" data-cid="${c.id}">验收通过</button>`);
    btns.push(`<button class="btn mini bad" data-verdict="fail" data-cid="${c.id}">退回重做</button>`);
  }
  return `<div class="tcard" data-open="card" data-id="${c.id}">
    <div class="tt">${esc(c.title)}</div>
    <div class="ww">${esc(c.why)}</div>
    <div class="dd"><i>怎么算完成：</i>${esc(c.done_def)}</div>
    <div class="mm">
      <span class="chip ${c.level.toLowerCase()}">${esc(c.level)}</span>
      <span class="chip">${esc(c.owner)}</span>
      <span class="chip">第 ${c.check_day} 天</span>
      ${gate ? `<span class="chip warn">欠决策</span>` : ""}
      ${c.verdict === "pass" ? `<span class="chip ok">验收通过</span>` : c.verdict === "fail" ? `<span class="chip bad">验收不过</span>` : ""}
    </div>
    ${c.next_action ? `<div class="nx">${esc(c.next_action)}：${esc(c.next_reason || "")}</div>` : ""}
    ${btns.length ? `<div class="tact">${btns.join("")}</div>` : ""}
  </div>`;
}

function renderTasks() {
  const cols = STATUS_COLS.map(([k, label]) => {
    const list = S.cards.filter((c) => c.status === k);
    return `<div class="col"><div class="col-h">${label}<span class="n">${list.length}</span></div>
      ${list.map(tcard).join("") || `<div style="color:var(--fg3);font-size:12px;padding:10px 6px">空</div>`}</div>`;
  }).join("");
  const blocked = S.cards.filter((c) => c.status === "blocked");
  return `<div class="stage">
    <div style="display:flex;align-items:center;gap:12px;margin:6px 0 16px">
      <button class="btn primary" data-act="assign">+ 派活</button>
      <input class="inp" id="q" placeholder="搜台账（标题 / 负责人 / 为什么）" style="max-width:340px" />
      <div style="margin-left:auto;color:var(--fg3);font-size:12px">
        ${S.cards.filter((c) => !["done", "cancelled"].includes(c.status)).length} 在办 · ${blocked.length} 卡住</div>
    </div>
    <div class="board">${cols}</div>
    ${blocked.length ? `<div class="sec-t">卡住 · 要报我</div>
      <div class="col hot">${blocked.map(tcard).join("")}</div>` : ""}
  </div>`;
}

function decPanel(d) {
  return `<div class="panel ${d.answer == null ? "pending" : ""}" data-open="dec" data-id="${d.id}">
    <div class="pt">${esc(d.question)}
      ${d.answer == null ? `<span class="chip warn">等我定</span>` : `<span class="chip ok">${esc(S.labels.answer[d.answer])}</span>`}</div>
    <div class="kv"><span class="k">① 要定什么</span><span class="v">${esc(d.question)}</span></div>
    <div class="kv"><span class="k">② 它建议什么</span><span class="v" style="max-width:64%">${esc(d.recommendation)}</span></div>
    <div class="kv"><span class="k">③ 代价是什么</span><span class="v" style="max-width:64%">${esc(d.cost)}</span></div>
    <div class="kv"><span class="k">④ 批的范围多大</span><span class="v" style="max-width:64%">${esc(d.scope)}</span></div>
    <div class="kv"><span class="k">⑤ 我不回会怎样</span><span class="v">${esc(d.silent_default)}</span></div>
    ${d.condition ? `<div style="margin-top:10px;font-size:12.5px;color:#F3D3A0;background:rgba(245,165,36,.07);
      border:1px solid rgba(245,165,36,.28);border-radius:9px;padding:9px 11px">条件：${esc(d.condition)}</div>` : ""}
  </div>${policyButtons(d)}`;
}

// 授权类决策：三个按钮定一次，之后这类任务不再问你
function policyButtons(d) {
  const m = String(d.scope || "").match(/policy:([^\s·]+)/);
  if (!m) return "";
  const cat = m[1];
  if (d.answer != null) return `<div class="poltag">已定：「${esc(cat)}」→ ${esc(d.condition || "")}</div>`;
  return `<div class="polact">
    <button class="btn mini ok" data-policy="auto" data-cat="${esc(cat)}">CEO 全权处理</button>
    <button class="btn mini" data-policy="human" data-cat="${esc(cat)}">以后交人工</button>
    <button class="btn mini bad" data-policy="ask" data-cat="${esc(cat)}">每次都问我</button>
  </div>`;
}

function renderApprovals() {
  const pending = S.decisions.filter((d) => d.answer == null);
  const lib = S.decisions.filter((d) => d.answer);
  return `<div class="stage">
    <div class="sec-t">等我定 · ${pending.length}</div>
    ${pending.map(decPanel).join("") || `<div class="empty">没有等我定的</div>`}
    <div class="sec-t">决定库 · ${lib.length}</div>
    <div style="display:flex;gap:9px;margin-bottom:12px">
      <input class="inp" id="dq" placeholder="翻以前怎么定的" style="max-width:320px" />
      <button class="btn" data-act="searchdec">翻</button>
    </div>
    <div id="dq-hits"></div>
    ${lib.map(decPanel).join("")}
  </div>`;
}

function renderCriteria() {
  return `<div class="stage">
    <div class="sec-t">判据 · 上架前先写标准，到点按标准读</div>
    ${S.criteria.map((k) => {
      const rules = JSON.parse(k.rules_json);
      const due = (S.sweep.due_criteria || []).some((x) => x.id === k.id);
      return `<div class="panel">
        <div class="pt">${esc(k.batch)}
          <span class="chip">第 ${k.read_day} 天读数</span>
          ${k.verdict ? `<span class="big ${k.verdict}">${esc(k.verdict)}</span>` : `<span class="chip">待读</span>`}</div>
        <div style="color:var(--fg3);font-size:12px">${esc(k.metric)} · 建于 ${esc(k.created_day)}</div>
        <div class="rules">${rules.map((r) => `<div class="rule ${esc(r.result)}">${esc(r.op)} ${r.value} → ${esc(r.result)}</div>`).join("")}</div>
        ${k.verdict
          ? `<div style="color:var(--fg2);font-size:12.5px">读到的数：<b class="big ${k.verdict}">${k.value}</b> · ${esc(hhmm(k.evaluated_at))}</div>`
          : `<div style="display:flex;gap:9px;align-items:center">
              <input class="inp" id="cv-${k.id}" type="number" placeholder="读到的数" style="max-width:160px" />
              <button class="btn${due ? " primary" : ""}" data-act="read:${k.id}" ${due ? "" : "disabled"}>
                ${due ? "按标准读" : `还没到第 ${k.read_day} 天`}</button>
             </div>`}
      </div>`;
    }).join("") || `<div class="empty">还没有判据</div>`}
  </div>`;
}

function renderAudit() {
  const sw = S.sweep;
  const grp = (title, list, f) => `<div class="sec-t">${title} · ${list.length}</div>
    <div class="rows">${list.map(f).join("") || `<div class="empty">无</div>`}</div>`;
  return `<div class="stage">
    <div style="display:flex;align-items:center;gap:12px;margin:6px 0 10px">
      <div style="color:var(--fg3);font-size:12.5px">CEO 每天按点巡一遍台账：到期没动的催，卡住的报我。</div>
      <button class="btn primary" style="margin-left:auto" data-act="patrol">巡一轮</button>
      <button class="btn" data-act="kb">知识沉淀</button>
    </div>
    ${grp("P0 大事欠决策", sw.need_decision || [], (x) => `<div class="rowx" data-open="card" data-id="${x.id}">
      <div class="bd"><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.owner)} · 一步都没法开工</div></div></div>`)}
    ${grp("到期没动", sw.overdue, (x) => `<div class="rowx" data-open="card" data-id="${x.id}">
      <div class="bd"><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.owner)} · 已过 ${x.gap} 天 / 约定第 ${x.check_day} 天</div></div></div>`)}
    ${grp("卡住", sw.stuck, (x) => `<div class="rowx" data-open="card" data-id="${x.id}">
      <div class="bd"><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.owner)}</div></div></div>`)}
    ${grp("待验收", sw.unverified, (x) => `<div class="rowx" data-open="card" data-id="${x.id}">
      <div class="bd"><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.owner)}</div></div></div>`)}
    ${grp("到点该读数", sw.due_criteria, (x) => `<div class="rowx" data-tabx="criteria">
      <div class="bd"><div class="t1">${esc(x.batch)}</div><div class="t2">${esc(x.metric)} · 第 ${x.read_day} 天</div></div></div>`)}
    ${grp("没人回 → 默认不做", sw.silent_decisions, (x) => `<div class="rowx" data-open="dec" data-id="${x.id}">
      <div class="bd"><div class="t1">${esc(x.question)}</div><div class="t2">${esc(x.silent_default)}</div></div></div>`)}
  </div>`;
}


// ── 选品页：采集 → 精挑 → 审核 → 你确认 ─────────────
let PIPE = { items: [], stages: [], by_stage: {} };
let MARKET = { items: [], categories: [], sources: [] };
let MARKET_SRC = "";   // 采到的榜单按源过滤（从选品卡片点进来时会被赋值）
let CATES = { ok: false, list: [], at: null, note: "", current: "" };
let CATE_OPEN = false;   // 类目面板是否展开（自绘，不用原生 select：白底白字看不清）

async function loadPipeline() {
  try { PIPE = await api("/api/pipeline"); } catch { PIPE = { items: [], by_stage: {} }; }
  try { MARKET = await api("/api/market"); } catch { MARKET = { items: [] }; }
  let srvCates = null;
  try { srvCates = await api("/api/market/cates"); } catch { srvCates = { ok: false, list: [] }; }
  // 保留用户刚选的类目：render() 会重跑 loadPipeline，整块覆盖会把选择冲掉
  CATES = { ...srvCates, current: CATES.current || srvCates.current || "" };
}

const STAGE_CN = {  candidate: "候选", ceo_review: "CEO 审核中", owner_confirm: "等你确认",
  approved: "已批准", assets_ready: "素材就绪", cost_pending: "等你填成本",
  ready: "可上架", listed: "已上架", ads_on: "投流中", rejected: "已否决",
};

function renderPipeline() {
  const stages = ["owner_confirm", "ceo_review", "candidate", "approved", "assets_ready", "cost_pending", "ready", "listed", "ads_on", "rejected"];
  const box = (st) => {
    const list = (PIPE.by_stage && PIPE.by_stage[st]) || [];
    if (!list.length) return "";
    return `<div class="sec-t">${STAGE_CN[st] || st} · ${list.length}</div>
      <div class="rows">${list.map((it) => `<div class="rowx">
        <div class="bd">
          <div class="t1">${esc(it.name)}</div>
          <div class="t2">${esc(it.ceo_reason || it.spec_idea || "")}</div>
        </div>
        <div class="act">
          ${st === "owner_confirm" ? `<button class="btn mini ok" data-pipe-yes="${it.id}">同意上货</button>
             <button class="btn mini bad" data-pipe-no="${it.id}">不要</button>` : ""}
          ${st === "cost_pending" || st === "ready" ? `<button class="btn mini" data-pipe-cost="${it.id}">填拿货价</button>` : ""}
        </div>
      </div>`).join("")}</div>`;
  };

  const srcs = MARKET.sources || [];
  const all = MARKET.items || [];
  const market = (MARKET_SRC ? all.filter((x) => x.source === MARKET_SRC) : all).slice(0, 40);
  const srcOpts = [`<option value=""${MARKET_SRC ? "" : " selected"}>全部源（${all.length} 条）</option>`]
    .concat(srcs.map((s) => `<option value="${esc(s.source)}"${MARKET_SRC === s.source ? " selected" : ""}>${esc(s.source)}（${s.n}）</option>`))
    .join("");

  // 类目下拉：只列接口真实返回的类目，选不到就不给选（不是让你手打）
  // 用自绘面板，不用原生 <select> —— Windows 原生下拉是白底白字，看不清
  const cates = (CATES.list || []).filter((c) => c.level >= 0 && c.name !== "总榜");
  const curCat = CATES.current || "";
  const catLabel = curCat ? `${curCat}${(cates.find((c) => c.name === curCat)?.level === 0) ? "（一级）" : ""}` : "全部类目（总榜）";
  const cateItems = [
    { v: "", t: "全部类目（总榜）", lv: -1 },
    ...cates.map((c) => ({
      v: c.name,
      t: `${c.name}${c.level === 0 ? "（一级）" : ""}`,
      lv: c.level,
    })),
  ];
  const cateMenu = cateItems.map((c) => `<div class="cateopt lv${c.lv}${c.v === curCat ? " on" : ""}" data-cate="${esc(c.v)}">${esc(c.t)}</div>`).join("");
  const cateHint = CATES.ok
    ? `类目树来自精选联盟接口 · ${cates.length} 个可选 · 更新 ${localHM(CATES.at)}`
    : (CATES.note || "还没类目树，先跑一次「③ 抓全类目榜」");

  return `<div class="stage">
    <div class="sec-t">采集 · 先扫码登一次，之后自动采</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
      <div class="catepick" id="catepick">
        <span class="catelabel">类目</span>
        <button class="btn catebtn${CATE_OPEN ? " open" : ""}" data-act="cate-toggle">
          <span>${esc(catLabel)}</span><i>▾</i>
        </button>
        <div class="catemenu"${CATE_OPEN ? "" : ' style="display:none"'}>${cateMenu}</div>
      </div>
      <button class="btn primary" data-act="pk-collect-buyin">② 按这个类目抓爆款榜</button>
      <button class="btn" data-act="pk-collect-buyin-all">③ 抓全类目榜</button>
      <button class="btn" data-act="pk-collect-compass">④ 抓电商罗盘</button>
      <button class="btn" data-act="pk-login-buyin">① 扫码登录精选联盟</button>
    </div>
    <div style="color:var(--fg3);font-size:12px;margin-bottom:10px">${esc(cateHint)} · 累计 ${MARKET.total || all.length} 条${srcs.length ? "（" + srcs.map((s) => s.source + " " + s.n).join(" / ") + "）" : ""}</div>

    <div class="sec-t" data-market-anchor>采到的榜单 · ${market.length} 条${MARKET_SRC ? `（只看 ${esc(MARKET_SRC)}）` : ""}</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <select class="inp" id="pk-src" style="max-width:320px">${srcOpts}</select>
      <span style="color:var(--fg3);font-size:12px">按「热销」排序 · 时间是最新抓取时间</span>
    </div>
    ${market.length ? `<div class="rows">${market.map((m) => `<div class="rowx">
      <div class="bd">
        <div class="t1">${esc(String(m.title).slice(0, 46))}</div>
        <div class="t2">${esc(m.source)} · ${esc(m.category || "")} · ${m.price != null ? "¥" + m.price : "价未知"} · 榜 ${m.sales_2h ?? "—"} · 佣金 ${m.commission_rate ?? "—"}% · <b>${esc(agoCn(m.fetched_at))}</b></div>
      </div>
    </div>`).join("")}</div>` : `<div class="empty">这个源还没数据。点上面 ② / ③ / ④ 采一次</div>`}

    <div class="sec-t">流水线</div>
    ${stages.map(box).join("") || `<div class="empty">还没有候选。先去上面采集，然后跑 <code>node select-products.mjs</code></div>`}
  </div>`;
}

function renderTodo() {
  return `<div class="stage">
    <div class="sec-t">待办 · ${D.todos.length} 件（都是后端算出来的，不是写的）</div>
    <div class="rows">
      ${D.todos.map((t, i) => `<div class="rowx" data-open="${t.kind}" data-id="${t.id}">
        <span class="chip ${t.k === "P0 欠决策" ? "p0" : t.k === "卡住" || t.k === "没人回" ? "bad" : "warn"}">${esc(t.k)}</span>
        <div class="bd"><div class="t1">${esc(t.t)}</div><div class="t2">${esc(t.owner)} · ${esc(t.why)}</div></div>
        <div class="when">#${i + 1}</div>
      </div>`).join("") || `<div class="empty">今天没有要你动手的</div>`}
    </div>
  </div>`;
}

/* ── 店铺：能开 N 个，每家一个 Agent + 一条连接器 ─────────── */

// 一家店 = 一行。竖排，开 10 家就是 10 行，不并排挤成小格子。
function storeRow(s, opts = {}) {
  // 顺序按你说的来：平台名 → 连接灯（绿=已连 / 红=未连）→ 店铺名
  const connected = !!s.alive;
  const dotCls = connected ? "ok" : "bad";
  const modeName = s.mode === "api" ? "官方 API" : s.mode === "browser" ? "扫码/浏览器" : "CSV";
  const creds = s.mode === "api" && !s.creds_ready ? `缺 ${(s.envs || []).join(" / ")}` : "";
  const where = s.connect?.where ? ` · 过滤 ${s.connect.where}` : "";
  const src = s.mode === "csv"
    ? `${esc(s.connect?.path || "")}${esc(where)}`
    : s.mode === "browser"
      ? `${esc(s.connect?.url || "")} <span style="color:var(--fg3)">@ ${esc(s.connect?.selector || "")}</span>`
      : "";
  return `<div class="rowx store${opts.click ? " click" : ""}"${opts.click ? ` data-open="agent" data-id="${esc(s.agent)}"` : ""}>
    <div class="bd">
      <div class="t1">
        ${opts.actions ? `<label class="pickwrap" title="勾选后可批量分析"><input type="checkbox" class="pick" data-pick="${esc(s.agent)}" ${PICKED.has(s.agent) ? "checked" : ""} /></label>` : ""}
        <span class="chip pf">${esc(s.platform_name)}</span>
        <i class="dot ${dotCls}" title="${connected ? "已连接" : "未连接"}"></i>
        <b class="sname">${esc(s.name)}</b>
        <span class="chip ${s.mode === "csv" ? "ok" : "warn"}">${modeName}</span>
        <span class="chip win" title="当前这批数据是按哪个时间窗抓的">${esc(s.window_label || "实时")}</span>
        <span class="t2" style="font-size:11px;color:${connected ? "var(--ok)" : "var(--bad)"}">${connected ? "已连接" : "未连接"}</span>
        ${s.params_ready ? "" : `<span class="chip" style="background:rgba(245,165,36,.14);border-color:rgba(245,165,36,.4);color:#F5A524">参数待填</span>`}
      </div>
      <div class="t2">Agent <b style="color:var(--fg2)">${esc(s.agent)}</b> · 连接器 ${esc(s.connector)}${src ? " · " + src : ""}</div>
      ${(s.extras || []).length ? `<div class="xmeta">${s.extras.map((e) =>
        `<span class="chip ${e.ok ? "" : "warn"}">${esc(e.label)} <b>${esc(e.ok ? e.value : "—")}</b></span>`).join("")}</div>` : ""}
      ${creds ? `<div class="t2" style="color:#F5A524">${esc(creds)}</div>` : ""}
    </div>
    <div class="numwrap">
      <div class="num">${esc(s.metric_value)}</div>
      <div class="t2">${esc(s.metric_label)}</div>
    </div>
    <div class="t2" style="width:170px;text-align:right">
      <div style="color:var(--fg2)">${esc(stampOf(s.last_run_at))}</div>
      <div style="color:var(--fg3);font-size:11px">${esc(s.metric_extra || "")}</div>
    </div>
    ${opts.actions ? `<div class="acts">
      <span class="winbtns">
        ${["实时", "近7天", "近30天"].map((w) =>
          `<button class="btn wbtn${(s.window_label || "实时") === w ? " on" : ""}" data-ecom-win="${w}" data-agent="${esc(s.agent)}" title="按「${w}」重取这家店的数据并分析">${w}</button>`
        ).join("")}
      </span>
      <button class="btn" data-shop-assign="${esc(s.agent)}">派活</button>
      <button class="btn" data-shop-cost="${esc(s.agent)}">参数</button>
      <button class="btn" data-shop-test="${esc(s.id)}">试连</button>
      <button class="btn" data-shop-del="${esc(s.id)}" style="color:var(--bad)">删</button>
    </div>` : ""}
  </div>`;
}

function renderShops() {
  const list = SHOPS.shops || [];
  const plats = (SHOPS.platforms || []).map((p) => p.name).join(" / ");

  // ── 口径分组汇总 ────────────────────────────────────────
  // 不同时间窗的数据不能相加（实时 + 近7天 混在一起算总和是错的），
  // 按窗口分组小计；窗口不一致时明确说不合并。
  const numOf = (s, label) => {
    const e = (s.extras || []).find((x) => x.label === label);
    if (!e || e.value == null || e.value === "—") return null;
    const v = Number(String(e.value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(v) ? v : null;
  };
  const groups = new Map();
  for (const s of list) {
    const w = s.window_label || "实时";
    const g = groups.get(w) || { w, shops: [], gmv: 0, orders: 0, hasGmv: false, hasOrders: false };
    g.shops.push(s);
    const v = numOf(s, "成交金额"); if (v !== null) { g.gmv += v; g.hasGmv = true; }
    const o = numOf(s, "成交订单数"); if (o !== null) { g.orders += o; g.hasOrders = true; }
    groups.set(w, g);
  }
  const gArr = [...groups.values()].sort((a, b) => b.shops.length - a.shops.length);
  const mixed = gArr.length > 1;

  const summaryHTML = list.length ? `
    <div class="panel" style="margin:0 0 16px;padding:13px 17px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="font-size:13px">口径汇总</b>
        ${mixed
          ? `<span class="chip" style="background:rgba(245,165,36,.14);border-color:rgba(245,165,36,.45);color:#F5A524">⚠ 各店时间窗不同，不能合成一个总数</span>`
          : `<span class="chip ok">同一口径（${esc(gArr[0]?.w || "实时")}），可以合并</span>`}
      </div>
      <div style="display:flex;gap:28px;margin-top:10px;flex-wrap:wrap">
        ${gArr.map((g) => `<div>
          <div class="t2" style="margin-bottom:3px">${esc(g.w)} · ${g.shops.length} 家</div>
          <div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">
            ${g.hasGmv ? `¥${(Math.round(g.gmv * 100) / 100).toFixed(2)}` : "—"}
            <span style="font-size:11px;color:var(--fg3);font-weight:400">成交</span>
            ${g.hasOrders ? `　${g.orders}<span style="font-size:11px;color:var(--fg3);font-weight:400"> 单</span>` : ""}
          </div>
          <div class="t2" style="font-size:11px">${g.shops.map((s) => esc(s.name)).join(" · ")}</div>
        </div>`).join("")}
      </div>
      ${mixed ? `<div class="t2" style="margin-top:8px;color:#F5A524">要合计就把各店切到同一时间窗（行内按钮，或上面「全部·xx」）。</div>` : ""}
    </div>` : "";

  return `<div class="stage">
    <div style="display:flex;align-items:center;gap:12px;margin:6px 0 16px">
      <div style="color:var(--fg2);font-size:13px">
        <b>${list.length}</b> 家店在管 · 每家店 = 一个 Agent + 一条连接器 · 时间窗按店铺各自切换，不同窗口不合并</div>
      <button class="btn primary" style="margin-left:auto" data-act="openshop">+ 开一个店铺</button>
      <span style="display:inline-flex;gap:6px;margin-left:8px">
        <button class="btn" data-batch="own" title="对勾选的店铺，按它们各自的时间窗逐个分析">批量分析${PICKED.size ? `（${PICKED.size}）` : ""}</button>
        <button class="btn" data-batch="实时">勾选·实时</button>
        <button class="btn" data-batch="近7天">勾选·近7天</button>
        <button class="btn" data-batch="近30天">勾选·近30天</button>
      </span>
      <span style="display:inline-flex;gap:0;margin-left:8px" title="对全部店铺按同一时间窗重取并分析">
        <button class="btn" data-ecom-win="实时" data-agent="__all__">全部·实时</button>
        <button class="btn" data-ecom-win="近7天" data-agent="__all__">全部·近7天</button>
        <button class="btn" data-ecom-win="近30天" data-agent="__all__">全部·近30天</button>
      </span>
      <button class="btn" data-act="login">扫码登录</button>
      <button class="btn" data-act="cost">经营参数</button>
      <button class="btn" data-act="aimodel">模型接入</button>
    </div>
    ${summaryHTML}
    ${list.length
      ? `<div class="rows">${list.map((s) => storeRow(s, { actions: true })).join("")}</div>`
      : `<div class="empty">还没有店。点右上角「+ 开一个店铺」。</div>`}
    <div style="color:var(--fg3);font-size:11.5px;margin-top:18px;line-height:1.7">
      连接入口两种：<b>CSV</b> —— 把后台导出的报表指过来，改完就自动进台账；
      <b>官方 API</b> —— 填对应环境变量（抖店 DOUYIN_SHOP_*、拼多多 PDD_*、淘宝 TAOBAO_*），缺了会明说缺哪个。
    </div>
  </div>`;
}

// ── 千川投流页 ────────────────────────────────────────
let TC = { snapshot: null, ads: [], advice: [] };
async function loadTc() {
  try { TC = await api("/api/tc"); } catch { TC = { snapshot: null, ads: [], advice: [] }; }
}

const TC_ACTION_COLOR = { 放量: "#43c98b", 控成本: "#f0b23a", 关停: "#ef6b6b", 空跑: "#f0b23a", 观察: "#8a93a5", 学习期不动: "#8a93a5" };

function renderTc() {
  const s = TC.snapshot || {};
  const ads = TC.ads || [];
  const adv = (TC.advice || []).slice(0, 12);
  const adviceOf = (adId) => (TC.advice || []).find((x) => x.ad_id === String(adId) && x.status === "open");
  const y = (n) => (n == null ? "—" : `¥${Number(n).toFixed(2)}`);

  const cards = [
    ["账户余额", y(s.balance)],
    ["今日消耗", y(s.cost_today)],
    ["今日成交", y(s.gmv_today)],
    ["今日 ROI", s.roi_today ?? "—"],
    ["计划数", `${ads.length} 个`],
  ].map(([k, v]) => `<div class="mcard" style="padding:10px 12px"><div class="top">${esc(k)}</div><div class="v"><span class="n">${esc(String(v))}</span></div></div>`).join("");

  return `<div class="stage">
    <div class="sec-t">千川 · 全域推广（数据 ${s.at ? esc(agoCn(s.at)) : "还没采"}）</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">${cards}</div>

    <div class="sec-t">计划 · ${ads.length} 个</div>
    <div class="rows">
      ${ads.map((a) => {
        const raw = (() => { try { return JSON.parse(a.raw || "{}"); } catch { return {}; } })();
        const d7 = raw.d7 || {};
        const roi7 = d7.cost > 0 ? (d7.gmv / d7.cost).toFixed(2) : "—";
        const ad = adviceOf(a.ad_id);
        const tag = ad ? `<span style="color:${TC_ACTION_COLOR[ad.action] || "#8a93a5"};font-weight:600">${esc(ad.action)}</span>` : `<span style="color:var(--fg3)">—</span>`;
        return `<div class="rowx">
          <div class="bd">
            <div class="t1">${esc(a.name)}　${tag}</div>
            <div class="t2">${esc(a.status || "")} · 预算 ${y(a.budget)} · 目标ROI ${a.roi_goal ?? "—"} · 今日 ${y(a.cost)} · 7天 ${y(d7.cost)} / ROI ${roi7} · 30天 ${y(raw.d30?.cost)}</div>
          </div>
        </div>`;
      }).join("")}
    </div>

    <div class="sec-t">建议 · 最近 ${adv.length} 条</div>
    <div class="rows">
      ${adv.length ? adv.map((x) => `<div class="rowx">
        <div class="bd">
          <div class="t1"><span style="color:${TC_ACTION_COLOR[x.action] || "#8a93a5"};font-weight:600">[${esc(x.level)}] ${esc(x.action)}</span> · ${esc(x.ad_name || x.ad_id)}</div>
          <div class="t2">${esc(x.reason || "")}${x.decision_id ? ` · 决策包 #${x.decision_id}（等你批）` : ""} · ${esc(agoCn(x.at))}</div>
        </div>
      </div>`).join("") : `<div class="empty">还没有建议。跑一次 <code>node tc-agent.mjs</code></div>`}
    </div>

    <div class="sec-t">素材库 · ${(TC.materials || []).length} 条</div>
    <div class="rows">
      ${(() => {
        const ms = TC.materials || [];
        if (!ms.length) return `<div class="empty">还没采素材。跑 <code>node sync.mjs qianchuan-materials</code></div>`;
        const bad = ms.filter((m) => m.audit === 2);
        const pend = ms.filter((m) => m.audit === 0);
        const low = ms.filter((m) => m.low_eff);
        const good = ms.filter((m) => m.high_q);
        const spent = ms.filter((m) => Number(m.cost) > 0);
        const line = `<div class="rowx"><div class="bd"><div class="t1">通过 ${ms.length - bad.length - pend.length} · 不通过 ${bad.length}${pend.length ? ` · 待审 ${pend.length}` : ""}${low.length ? ` · 低效 ${low.length}` : ""}${good.length ? ` · 优质 ${good.length}` : ""} · 有消耗 ${spent.length}</div>
          <div class="t2">按近7天消耗排序 · ROI 是支付 ROI（素材维度）</div></div></div>`;
        const rows2 = ms.slice(0, 10).map((m) => {
          const c = Number(m.cost || 0);
          const color = m.audit === 2 ? "#ef6b6b" : c > 0 ? (Number(m.roi) >= 2.9 ? "#43c98b" : "#f0b23a") : "var(--fg2)";
          return `<div class="rowx"><div class="bd">
            <div class="t1" style="color:${color}">${esc(String(m.title).slice(0, 46))}</div>
            <div class="t2">消耗 ¥${c.toFixed(2)} · ROI ${m.roi == null ? "—" : Number(m.roi).toFixed(2)} · 点击率 ${m.ctr == null ? "—" : Number(m.ctr).toFixed(2) + "%"} · 转化率 ${m.cvr == null ? "—" : Number(m.cvr).toFixed(2) + "%"} · ${m.audit === 2 ? "审核不通过" : m.audit === 0 ? "待审" : "已通过"}</div>
          </div></div>`;
        }).join("");
        const items = rows2;
        return line + items;
      })()}
    </div>

    <div class="sec-t">执行边界</div>
    <div style="color:var(--fg2);font-size:12.5px;line-height:1.7">
      分析、判断、出建议全自动；<b>改预算 / 调出价 / 关停计划不会自己动手</b> —— 千川的写接口还没接，而且这是花钱的事，
      按规矩要你批。P0 建议会自动开决策包，你点同意我再执行（或给你后台逐步操作路径）。
    </div>
  </div>`;
}

function renderView() {
  const map = {
    overview: renderOverview, brief: renderBrief, tasks: renderTasks,
    approvals: renderApprovals, criteria: renderCriteria, audit: renderAudit, todo: renderTodo,
    pipeline: renderPipeline,
    tc: renderTc,
    shops: renderShops,
  };
  return (map[currentTab] || renderOverview)();
}

async function render() {
  if (currentTab === "pipeline") { await loadPipeline(); }
  if (currentTab === "tc") { await loadTc(); }
  D = buildD(S, ACT);
  renderTabs();
  $("#view").innerHTML = renderView();
  $("#duty-count").textContent = `${S.agents.filter((a) => a.alive).length}/${S.agents.length}`;
  $("#brand-logo").textContent = PROFILE.org.logo || "AI";
  $("#brand-logo").title = PROFILE.org.name || "";
  $("#brand-name").textContent = (PROFILE.org.name || "AI NATIVE").toUpperCase();
  $("#maskbtn").classList.toggle("on", MASK.on);
  document.title = `指挥台 · ${PROFILE.org.name || "AI Native 内核"} · ${(D.tabs.find((t) => t.id === currentTab) || {}).label || ""}`;
  if (location.hash.slice(1) !== currentTab) history.replaceState(null, "", "#" + currentTab);
  $("#foot-left").innerHTML = D.footerLeft;
  $("#foot-right").innerHTML = D.footerRight;
  requestAnimationFrame(drawFan);
}

/* ── 实时：SSE 订阅，数据一变页面自己更新 ───────────────── */

let ES = null;
let LIVE = false;

function setLive(on, label) {
  LIVE = on;
  const el = $("#live");
  if (!el) return;
  el.classList.toggle("on", on);
  el.querySelector("b").textContent = label || (on ? "实时" : "已断开");
}

// 用户正在输入 / 开着对话框时不要重渲染，否则会打断输入
function busyUI() {
  const a = document.activeElement;
  const typing = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  return typing || $("#dlg")?.open || $("#shopdlg")?.open;
}

function connectStream() {
  if (ES) return;
  ES = new EventSource("/api/stream");

  ES.addEventListener("state", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    S = msg.state;
    setLive(true, "实时");
    if (busyUI()) return;          // 别打断输入
    render();
  });

  ES.onopen = () => setLive(true, "实时");
  ES.onerror = () => {
    setLive(false, "重连中");
    // EventSource 自己会重连，这里不用重开
  };
}

/* 顶栏时钟（他那套右上角一直在跳） */
function tickClock() {
  const el = $("#clock");
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000);
tickClock();

/* 隐藏店名：只换显示，不动数据 */
document.addEventListener("click", (e) => {
  if (!e.target.closest("#maskbtn")) return;
  MASK.on = !MASK.on;
  localStorage.setItem("ainative.mask", MASK.on ? "1" : "0");
  render();
});

/* ── 扇形连线（沿用 8899 的算法） ─────────── */

function drawFan() {
  const svg = $("#fan");
  const stage = $("#stage");
  if (!svg || !stage) return;
  const ceo = stage.querySelector(".ceo");
  const allCards = [...stage.querySelectorAll(".mesh .mcol .acard")];
  if (!ceo || !allCards.length) return;
  // 只往第一排画线：店铺多了会换行，第二排接线会把标签糊在卡片标题上
  const rowTop = Math.min(...allCards.map((c) => c.getBoundingClientRect().top));
  const cards = allCards.filter((c) => Math.abs(c.getBoundingClientRect().top - rowTop) < 8);

  const S2 = stage.getBoundingClientRect();
  const c = ceo.getBoundingClientRect();
  const x0 = c.left - S2.left + c.width / 2;
  const y0 = c.top - S2.top + c.height;
  const M = D.motion;
  const DOT = 3;

  let base = "", flow = "", labels = "";

  cards.forEach((card, i) => {
    const r = card.getBoundingClientRect();
    const x1 = r.left - S2.left + r.width / 2;
    const y1 = r.top - S2.top;
    const dy = Math.max(34, (y1 - y0) * 0.55);
    const d = `M ${x0} ${y0} C ${x0} ${y0 + dy}, ${x1} ${y1 - dy}, ${x1} ${y1}`;
    const pid = `fedge-${i}`;
    const a = D.agents.find((x) => x.id === card.dataset.id);
    const delegated = a ? a.edge.delegated : 0;
    const stale = a && a.noteErr;

    base += `<path id="${pid}" d="${d}" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1"/>`;
    base += `<circle cx="${x1}" cy="${y1}" r="8" fill="rgba(140,175,255,.10)"/>`;
    base += `<circle cx="${x1}" cy="${y1}" r="2.6" fill="rgba(170,200,255,.85)"/>`;

    if (M.enabled) {
      const color = stale ? "#FF7A6A" : "#8FB8FF";
      for (let k = 0; k < DOT; k++) {
        const begin = -((M.reportDur * k) / DOT).toFixed(2);
        flow += `<circle r="${1.8 - k * 0.15}" fill="${color}" fill-opacity="${0.95 - k * 0.28}" cx="0" cy="0">` +
          `<animateMotion dur="${M.reportDur}s" begin="${begin}s" repeatCount="indefinite" rotate="auto">` +
          `<mpath href="#${pid}"/></animateMotion></circle>`;
      }
      if (delegated > 0) {
        const dd = Math.max(0.9, M.delegateDur - Math.min(0.6, delegated * 0.1));
        for (let k = 0; k < DOT; k++) {
          const begin = -((dd * k) / DOT).toFixed(2);
          flow += `<circle r="2.1" fill="#FF9A4D" fill-opacity="${0.95 - k * 0.28}" cx="0" cy="0">` +
            `<animateMotion dur="${dd}s" begin="${begin}s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">` +
            `<mpath href="#${pid}"/></animateMotion></circle>`;
        }
      }
    }

    // 标签已改由 HTML 的 .labels 渲染（会跟列宽自适应），SVG 只画线
  });

  svg.setAttribute("viewBox", `0 0 ${S2.width} ${S2.height}`);
  svg.setAttribute("width", S2.width);
  svg.setAttribute("height", S2.height);
  svg.innerHTML = base + flow;
}

/* ── 抽屉 ─────────────────────────────── */

const drawer = $("#drawer");
const scrim = $("#scrim");

function openDrawer({ kicker, title, rows, actions }) {
  $("#drawer-kicker").textContent = kicker;
  $("#drawer-title").textContent = title;
  $("#drawer-body").innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v" style="max-width:66%">${v}</span></div>`)
    .join("");
  $("#drawer-actions").innerHTML = (actions || [])
    .map((a, i) => `<button class="btn${i === 0 ? " primary" : ""}" data-act="${a.id}">${esc(a.label)}</button>`)
    .join("");
  drawer.classList.add("open");
  scrim.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  drawer.classList.remove("open");
  scrim.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function openCardDrawer(id) {
  const c = S.cards.find((x) => x.id === id);
  if (!c) return;
  const gate = c.gate === "need_decision";
  const acts = [];
  if (c.status === "todo") acts.push(gate ? { id: `askdec:${c.id}`, label: "提请决策" } : { id: `doing:${c.id}`, label: "开工" });
  if (c.status === "doing") acts.push({ id: `review:${c.id}`, label: "交活" }, { id: `blocked:${c.id}`, label: "卡住" });
  if (c.status === "blocked") acts.push({ id: `doing:${c.id}`, label: "恢复" });
  if (c.status === "review") acts.push({ id: `pass:${c.id}`, label: "验收通过" }, { id: `fail:${c.id}`, label: "退回重做" });

  openDrawer({
    kicker: `TASK · ${c.level}`,
    title: c.title,
    rows: [
      ["负责", esc(c.owner)],
      ["状态", esc(S.labels.status[c.status]) + (gate ? " · 欠我的决策包" : "")],
      ["为什么做", esc(c.why)],
      ["要交什么", esc(c.deliverable)],
      ["怎么算完成", esc(c.done_def)],
      ["第几天回看", `第 ${c.check_day} 天（建于 ${esc(c.created_day)}）`],
      ["验收结论", c.verdict === "pass" ? "通过" : c.verdict === "fail" ? "不过" : "还没验"],
      ["决策包", c.decision_id ? `#${c.decision_id}` : "没有"],
    ],
    actions: acts,
  });
}

function openDecDrawer(id) {
  const d = S.decisions.find((x) => x.id === id);
  if (!d) return;
  const acts = d.answer == null
    ? [{ id: `agree:${d.id}`, label: "同意" }, { id: `conditional:${d.id}`, label: "附条件同意" }, { id: `reject:${d.id}`, label: "不同意" }, { id: `defer:${d.id}`, label: "另定" }]
    : [];
  openDrawer({
    kicker: "DECISION",
    title: d.question,
    rows: [
      ["① 要定什么", esc(d.question)],
      ["② 它建议什么", esc(d.recommendation)],
      ["③ 代价是什么", esc(d.cost)],
      ["④ 批的范围多大", esc(d.scope)],
      ["⑤ 我不回会怎样", esc(d.silent_default)],
      ["我的回复", d.answer ? esc(S.labels.answer[d.answer]) + (d.condition ? `（${esc(d.condition)}）` : "") : "还没回 —— 不回就是不做"],
      ["谁提的", esc(d.asked_by)],
    ],
    actions: acts,
  });
}

function openAgentDrawer(id) {
  const a = S.agents.find((x) => x.id === id);
  if (!a) return;

  // 只回答一件事：它靠什么活 / 算出了什么 / 判出什么 / 派了什么 / 还差你什么。
  // 「打心跳、熄灯、排班表」这类既看不懂又不干活的东西全部撤掉。
  const mine = S.cards.filter((c) => c.owner === id);
  const openCards = mine.filter((c) => !["done", "cancelled"].includes(c.status));
  const rep = a.last_report;
  const p = (() => { try { return rep && rep.payload_json ? JSON.parse(rep.payload_json) : {}; } catch { return {}; } })();

  const shop = (SHOPS.shops || []).find((x) => x.agent === id) || (id === "shop" ? (SHOPS.shops || [])[0] : null);
  // 口径一致性：抽屉里的数必须来自同一轮。
  // 之前这里取 shop.window（实时），但「最近汇报」可能是近7天，两个口径混在一起自相矛盾。
  const repWin = (p.facts && p.facts.window) || p.window || null;
  const win = repWin || (shop ? (shop.window || "实时") : "实时");
  const shopWin = shop ? (shop.window || "实时") : null;
  const snap = shop && shop.windows && shop.windows[win] ? shop.windows[win].metrics : {};
  const get = (label) => {
    const v = Object.values(snap).find((m) => m && m.label === label);
    if (!v) return null;
    if (v.value === "-") return "—";
    return v.ok ? String(v.value) : "未取到";
  };

  const conns = ALL_CONNS.filter((c) => c.enabled
    && (c.agent === id || (id === "shop" && shop && c.agent === shop.agent)));
  const diag = (p.diagnose || []).filter((d) => d.lv === "bad" || d.lv === "warn").slice(0, 6);
  const tasks = (p.tasks || []).slice(0, 8);
  const escs = (p.escalations || []).slice(0, 5);
  const waitDec = S.decisions.filter((d) => d.answer == null);

  const rows = [];

  rows.push(["靠什么活", conns.length
    ? conns.map((c) => xesc(c.label || c.id)).join(" / ") + (shop ? " · " + xesc(shop.platform_name) + " " + xesc(shop.name) + "（窗口 " + xesc(win) + "）" : "")
    : "没有启用中的连接器 → 它现在是空转的"]);

  if (shop) {
    rows.push(["这一窗的真数（" + win + (win === "实时" ? "，今天 0 点起" : "") + "）", [
      "成交 " + (get("成交金额") || "?"),
      "订单 " + (get("成交订单数") || "?") + " 单",
      "曝光 " + (get("商品曝光") || "?"),
      "点击 " + (get("商品点击") || "?"),
      "转化 " + (get("曝点转化率") || "?"),
    ].join(" · ")]);
    const snapAt = (shop.windows && shop.windows[win] && shop.windows[win].at) || shop.window_at;
    rows.push(["数据新鲜度", snapAt ? localHM(snapAt) + " 抓的（" + agoCn(snapAt) + "）" : "还没抓过"]);
  }

  if (p.facts) {
    const fx = p.facts;
    const parts = [];
    const gmv = fx.gmv != null ? fx.gmv : fx["明细买家支付"];
    const income = fx.income != null ? fx.income : fx["明细商家收入"];
    let fee = fx["优惠分摊合计"];
    if (fee == null && gmv > 0 && income > 0 && income < gmv) fee = +(gmv - income).toFixed(2);
    if (fee != null) parts.push("优惠分摊 ¥" + fee);
    if (fx.feeRate > 0) parts.push("佣金 " + (Math.round(fx.feeRate * 10000) / 100) + "%（¥" + fx.commission + "）");
    if (income != null) parts.push("商家收入 ¥" + (Math.round(income * 100) / 100));
    const missing = fx["缺成本的规格"];
    if (Array.isArray(missing) && missing.length) parts.push("毛利：缺 " + missing.length + " 个规格拿货价");
    else if (fx.costed != null && fx.costed > 0) parts.push("成本已填 " + fx.costed + " 个 SKU");
    else if (p.costReady === false) parts.push("毛利：成本没填");
    const bill = fx.billCoverage != null ? "（账单对账 " + fx.billCoverage + "%）" : "";
    rows.push(["算出来的" + (fx.detailOrders ? "（按明细 " + fx.detailOrders + " 单" + bill + "）" : ""), parts.join(" · ") || "—"]);

    // 后台口径和明细口径必然不等，差的单数是「已关闭/退款/未结算」，不解释就会被当成算错
    const dashN = fx.dashOrders || 0;
    const detN = fx.detailOrders || 0;
    if (dashN && detN && Math.abs(dashN - detN) / dashN > 0.02) {
      rows.push(["口径对照",
        "后台 " + dashN + " 单 / 成交 ¥" + get("成交金额") +
        "（实付 ¥" + get("用户支付金额") + "）；明细有效 " + detN + " 单 / 标价合计 ¥" + (fx.gmv != null ? Math.round(fx.gmv * 100) / 100 : "?") +
        "（扣券后收入 ¥" + (fx.income != null ? Math.round(fx.income * 100) / 100 : "?") + "）。" +
        "差的 " + (dashN - detN) + " 单是已关闭/退款/未结算，不计入有效"]);
    }
  }

  const judgedAt = rep ? localHM(rep.created_at || rep.day) : null;
  if (shopWin && repWin && shopWin !== repWin) {
    rows.push(["口径不一致", "店铺选「" + shopWin + "」，最近汇报按「" + repWin + "」算的。跑一次 node ecom-plan.mjs 就会自动对齐"]);
  }
  rows.push(["它判出的问题" + (judgedAt ? "（按 " + judgedAt + " 那轮数据）" : ""), diag.length
    ? diag.map((d) => (d.lv === "bad" ? "[X] " : "[!] ") + xesc(d.t)).join("<br>")
    : "这一轮没发现异常"]);

  rows.push(["它开的活", tasks.length
    ? tasks.map((t) => "[" + xesc(t.level) + "] " + xesc(t.title)).join("<br>")
    : (openCards.length ? openCards.map((c) => "[" + xesc(c.level) + "] " + xesc(c.title)).join("<br>") : "没有")]);

  rows.push(["要你拍板", escs.length
    ? escs.map((x) => "[P0] " + xesc(x.title)).join("<br>")
    : (waitDec.length ? waitDec.map((d) => "#" + d.id + " " + xesc(d.question)).join("<br>") : "没有")]);

  if (rep) rows.push(["最近一次汇报", "[" + localHM(rep.created_at || rep.day) + "] " + xesc(String(rep.summary || "").slice(0, 160))]);

  openDrawer({ kicker: "AGENT", title: a.name, rows, actions: [{ id: "assign:" + a.id, label: "派活给" + a.name }] });
}

function xesc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ── 交互 ─────────────────────────────── */

let pendingActor = "ceo";

document.addEventListener("click", async (e) => {
  // 类目面板开着时，点面板外面就收起（先收，不继续处理这次点击）
  if (CATE_OPEN && !e.target.closest("#catepick")) {
    CATE_OPEN = false;
    render();
    return;
  }

  // ── 选品页：扫码 / 采集 ────────────────────────────
  const pkAct = e.target.closest("[data-act]");
  const pkVerb = pkAct ? pkAct.dataset.act : "";
  if (pkVerb === "cate-toggle") {
    CATE_OPEN = !CATE_OPEN;
    render();
    return;
  }
  const cateOptEl = e.target.closest("[data-cate]");
  if (cateOptEl) {
    CATES.current = cateOptEl.dataset.cate || "";
    CATE_OPEN = false;
    render();
    return;
  }
  if (pkVerb === "pk-login-buyin") {
    try {
      await api("/api/login/buyin", "POST", {});
      toast("浏览器已弹出，去扫码（开通橱窗的抖音号）；扫完自己关窗");
    } catch (e) { toast(e.message, true); }
    return;
  }
  if (pkVerb === "pk-collect-buyin" || pkVerb === "pk-collect-compass" || pkVerb === "pk-collect-buyin-all") {
    const catPick = CATES.current || "";
    if (pkVerb === "pk-collect-buyin" && !catPick) {
      toast("先在左边选一个类目；要全类目就点「③ 抓全类目榜」", true);
      return;
    }
    const cat = pkVerb === "pk-collect-buyin-all" ? "全类目" : (catPick || "全类目");
    const source = pkVerb === "pk-collect-buyin" ? "buyin-hot"
      : pkVerb === "pk-collect-buyin-all" ? "buyin-hot-all"
      : "compass-hot";
    try {
      await api("/api/market/collect", "POST", { source, category: cat });
      toast(`开始采集「${cat}」，浏览器会弹出来，跑完自己关`);
    } catch (e) { toast(e.message, true); }
    return;
  }

  // 同意 / 不要 / 填成本
  const yes = e.target.closest("[data-pipe-yes]");
  if (yes) {
    e.stopPropagation();
    try {
      await api(`/api/pipeline/${yes.dataset.pipeYes}/stage`, "POST", { stage: "approved", owner_answer: "yes", owner_note: "界面同意" });
      toast("已批准，下一步做素材");
      await render();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const no = e.target.closest("[data-pipe-no]");
  if (no) {
    e.stopPropagation();
    try {
      await api(`/api/pipeline/${no.dataset.pipeNo}/stage`, "POST", { stage: "rejected", owner_answer: "no", owner_note: "界面否决" });
      toast("已否决");
      await render();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const cost = e.target.closest("[data-pipe-cost]");
  if (cost) {
    e.stopPropagation();
    const raw = prompt("按规格填拿货价，格式：尝鲜装=3,家庭装=6,囤货装=13");
    if (!raw) return;
    const costs = {};
    for (const kv of raw.split(/[,，]/)) {
      const [k, v] = kv.split("=");
      if (k && v && !Number.isNaN(Number(v))) costs[k.trim()] = Number(v);
    }
    if (!Object.keys(costs).length) return toast("格式不对：尝鲜装=3,家庭装=6", true);
    try {
      await api(`/api/pipeline/${cost.dataset.pipeCost}/cost`, "POST", { costs });
      toast("成本已记录，可以上架");
      await render();
    } catch (err) { toast(err.message, true); }
    return;
  }

  // ── 授权矩阵：定一次，以后自动 ────────────────────
  const pol = e.target.closest("[data-policy]");
  if (pol) {
    e.stopPropagation();
    const cat = pol.dataset.cat;
    const mode = pol.dataset.policy;
    const label = mode === "auto" ? "CEO 全权" : mode === "human" ? "交人处理" : "每次都问";
    try {
      const r = await api("/api/policies", "POST", { category: cat, mode, by: "S", note: "界面点选" });
      toast(`「${cat}」以后：${label}${r.closed_decisions ? `（结掉 ${r.closed_decisions} 张授权请求）` : ""}`);
      await reload();
    } catch (err) { toast(err.message, true); }
    return;
  }

  // ── 交活 ──────────────────────────────────────────
  const sub = e.target.closest("[data-submit]");
  if (sub) {
    e.stopPropagation();
    const id = Number(sub.dataset.submit);
    const note = prompt("交了什么？（写清楚，验收要对着看）");
    if (!note) return;
    const evidence = prompt("证据在哪？（文件路径 / 链接 / 数据出处，必填）");
    if (!evidence) return toast("没有证据不算交活", true);
    try {
      await api(`/api/cards/${id}/submit`, "POST", { by: "me", note, evidence });
      toast("已交活，等验收");
      await reload();
    } catch (err) { toast(err.message, true); }
    return;
  }

  // ── 验收 ──────────────────────────────────────────
  const vd = e.target.closest("[data-verdict]");
  if (vd) {
    e.stopPropagation();
    const id = Number(vd.dataset.cid);
    const pass = vd.dataset.verdict === "pass";
    const note = prompt(pass ? "验收意见（可空）" : "为什么不过？退回要写清哪里不行");
    if (!pass && !note) return toast("退回必须写原因", true);
    try {
      await api(`/api/cards/${id}/verdict`, "POST", { verifier: "me", verdict: pass ? "pass" : "fail", note: note || "" });
      toast(pass ? "验收通过，记进台账" : "已退回重做");
      await reload();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const tab = e.target.closest("[data-tab]");
  if (tab) { currentTab = tab.dataset.tab; render(); return; }
  const tabx = e.target.closest("[data-tabx]");
  if (tabx) { currentTab = tabx.dataset.tabx; render(); return; }

  // 点选品卡片里的采集源 → 直接进「选品页」并按这个源过滤
  const srcRow = e.target.closest("[data-src]");
  if (srcRow) {
    e.stopPropagation();
    MARKET_SRC = srcRow.dataset.src;
    currentTab = "pipeline";
    render();
    setTimeout(() => {
      const anchor = document.querySelector("#view .sec-t[data-market-anchor]");
      if (anchor) anchor.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 60);
    return;
  }

  const el = e.target.closest("[data-open]");
  if (el) {
    const kind = el.dataset.open, id = el.dataset.id;
    if (kind === "human") {
      openDrawer({
        kicker: "OWNER",
        title: "我 · 创始人",
        rows: [
          ["角色", D.org.role],
          ["等你处理", `${D.org.waiting} 件（后端六类巡检算出来的）`],
          ["拍板队列", `${esc(D.org.down.detail)} · ${esc(D.org.down.extra)}`],
          ["汇报节拍", `${esc(D.org.up.at)} · ${esc(D.org.up.detail)}`],
          ["下级", `${D.agents.length} 个业务 Agent + 1 个 CEO Agent`],
          ["铁律", "不回 = 不做、不花钱"],
        ],
        actions: [{ id: "goto-todo", label: "看那几件待办" }],
      });
    } else if (kind === "human-down" || kind === "human-up") {
      const isDown = kind === "human-down";
      openDrawer({
        kicker: isDown ? "DELEGATION" : "REPORTING",
        title: isDown ? D.org.down.title : D.org.up.title,
        rows: isDown
          ? [["方向", "创始人 → CEO Agent"], ["当前积压", esc(D.org.down.detail)], ["最早一件", esc(D.org.down.extra)],
             ["说明", "只有你能拍板的事才落这里；P0 卡没有决策包一步都动不了"]]
          : [["方向", "CEO Agent → 创始人"], ["上次汇报", esc(D.org.up.at)], ["今天条数", esc(D.org.up.detail)],
             ["时刻", esc(D.org.up.extra)], ["说明", "汇报由定时任务推送，不依赖你在线"]],
        actions: isDown ? [{ id: "goto-todo", label: "处理积压" }] : [{ id: "patrol", label: "让 CEO 现在巡一轮" }],
      });
    } else if (kind === "ceo") {
      openDrawer({ kicker: "AGENT · CEO", title: D.ceo.name, rows: D.ceo.detail, actions: [{ id: "patrol", label: "立即巡视一轮" }] });
    } else if (kind === "agent") openAgentDrawer(id);
    else if (kind === "card") openCardDrawer(Number(id));
    else if (kind === "dec") openDecDrawer(Number(id));
    else if (kind === "criteria") { currentTab = "criteria"; render(); }
    else if (kind === "metric") {
      const m = D.metrics.find((x) => x.id === id);
      if (!m) return;
      openDrawer({
        kicker: "METRIC",
        title: m.label,
        rows: [
          ["当前值", `${esc(m.value)}${esc(m.unit || "")}`],
          ["口径", esc(m.sub)],
          ["数据源", esc(m.src)],
          ["是否示例值", "否 —— 这个数是后端每次请求现算的"],
          ["刷新策略", "打开页面即取 /api/state；接定时任务后按排班刷"],
          ["负责人", "CEO Agent"],
        ],
        actions: [],
      });
    }
    return;
  }

  const shopAssign = e.target.closest("[data-shop-assign]");
  if (shopAssign) {
    const agentId = shopAssign.dataset.shopAssign;
    const s = (SHOPS.shops || []).find((x) => x.agent === agentId);
    openDlg({
      owner: agentId,
      title: s ? `${s.name}：` : "",
      why: s ? `${s.platform_name} · ${s.name} 当前 ${s.window_label || "实时"} 数据：${s.metric_label} ${s.metric_value}` : "",
    });
    return;
  }

  const shopCost = e.target.closest("[data-shop-cost]");
  if (shopCost) { openCostDlg(shopCost.dataset.shopCost); return; }

  // 勾选框
  const pick = e.target.closest("input[data-pick]");
  if (pick) {
    if (pick.checked) PICKED.add(pick.dataset.pick); else PICKED.delete(pick.dataset.pick);
    render();   // 只重画，按钮上的数量跟着变
    return;
  }

  // 批量：对勾选的店铺逐个分析
  const batchBtn = e.target.closest("[data-batch]");
  if (batchBtn) {
    if (!PICKED.size) { toast("先勾选店铺（行首的方框）", true); return; }
    const mode = batchBtn.dataset.batch;
    const label = batchBtn.textContent;
    batchBtn.textContent = "跑…";
    batchBtn.disabled = true;
    const agents = [...PICKED];
    toast(mode === "own"
      ? `正在按各自口径分析 ${agents.length} 家店…`
      : `正在按「${mode}」重取并分析 ${agents.length} 家店…`);
    try {
      const r = await api("/api/ecom/batch", "POST", mode === "own" ? { agents } : { agents, tab: mode });
      const bad = (r.results || []).filter((x) => !x.ok);
      if (bad.length) toast(`${bad.length} 家失败：${bad.map((x) => x.name || x.agent).join("、")}`, true);
      else toast(`${r.results.length} 家分析完成${r.ceo?.ok ? " · CEO 已裁决" : ""}`);
      await reload();
    } catch (err) { toast(err.message, true); }
    finally { batchBtn.textContent = label; batchBtn.disabled = false; }
    return;
  }

  if (e.target.closest('[data-act="aimodel"]')) {
    if (!openAiDialog) toast("模型面板还没加载好", true);
    else await openAiDialog();
    return;
  }

  // 时间窗 → 只重取「这家店」这个区间的真实数据 → 分析 → CEO
  const winBtn = e.target.closest("[data-ecom-win]");
  if (winBtn) {
    const tab = winBtn.dataset.ecomWin;
    const target = winBtn.dataset.agent || "__all__";
    const label = winBtn.textContent;
    winBtn.textContent = "跑…";
    winBtn.disabled = true;
    const who = target === "__all__" ? "全部店铺" : ((SHOPS.shops || []).find((s) => s.agent === target)?.name || target);
    toast(`正在按「${tab}」重取「${who}」，约 20~40 秒`);
    try {
      const r = await api("/api/ecom/refresh", "POST", { shop: target, tab });
      const bad = (r.steps || []).filter((s) => !s.ok);
      if (bad.length) {
        const why = (bad[0].out || "").split("\n").filter((l) => /✗|失败/.test(l)).slice(-1)[0] || bad[0].step;
        toast(`${bad[0].step} 失败：${why}`, true);
      } else {
        const n = (r.shops || [r.shop]).length;
        toast(`「${tab}」跑完 ${n} 家店：抓数 ✓ 分析 ✓ CEO ✓`);
      }
      await reload();
    } catch (err) {
      toast(err.message, true);
    } finally {
      winBtn.textContent = label;
      winBtn.disabled = false;
    }
    return;
  }

  const shopTest = e.target.closest("[data-shop-test]");
  if (shopTest) {
    const id = shopTest.dataset.shopTest;
    shopTest.textContent = "试连中…";
    shopTest.disabled = true;
    try {
      const r = await api(`/api/shops/${id}/test`, "POST", {});
      toast(r.ok ? `${id} 连上了：${r.value} ${r.extra || ""}` : `${id} 连不上：${r.error}`, !r.ok);
      await reload();
    } catch (err) {
      toast(err.message, true);
      shopTest.textContent = "试连";
      shopTest.disabled = false;
    }
    return;
  }

  const shopDel = e.target.closest("[data-shop-del]");
  if (shopDel) {
    const id = shopDel.dataset.shopDel;
    if (!confirm(`删掉这家店（${id}）？Agent 和连接器一起删，CSV 文件不动。`)) return;
    try { await api(`/api/shops/${id}`, "DELETE"); toast("删掉了"); await reload(); }
    catch (err) { toast(err.message, true); }
    return;
  }

  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const act = actEl.dataset.act;
    const [verb, arg] = act.split(":");
    try {
      if (verb === "patrol") {
        actEl.textContent = "巡视中…";
        const r = await api("/api/patrol", "POST", {});
        toast(`第 ${r.round} 轮巡视：出手 ${r.actions.length} 次`);
        await reload(); return;
      }
      if (verb === "kb") {
        const r = await api("/api/kb/absorb", "POST", {});
        toast(`知识沉淀：+${r.added} 条（跳过 ${r.skipped}）`);
        await reload(); return;
      }
      if (verb === "genbrief") {
        const r = await api("/api/briefs/generate", "POST", {});
        toast(`早报已生成：${r.headline}`);
        await reload(); return;
      }
      if (verb === "assign") {
        // 动作 id 是 "assign:shop" 这种形式时，act.split(":") 已经把后半段放进 arg
        closeDrawer();
        const aid = arg ? String(arg) : "";
        const ag = aid ? S.agents.find((x) => x.id === aid) : null;
        openDlg(ag ? { owner: aid, title: ag.name + "：", why: "从「" + ag.name + "」面板派活" } : {});
        return;
      }
      if (verb === "openshop") { openShopDlg(); return; }
      if (verb === "login") { openLoginDlg(); return; }
      if (verb === "cost") { openCostDlg(); return; }
      if (verb === "goto-todo") { closeDrawer(); currentTab = "todo"; render(); return; }
      if (verb === "searchdec") {
        const q = $("#dq").value.trim();
        if (!q) return toast("先写个词", true);
        const r = await api(`/api/decisions/search?q=${encodeURIComponent(q)}`);
        $("#dq-hits").innerHTML = r.hits.length
          ? r.hits.map((d) => `<div class="rowx" data-open="dec" data-id="${d.id}">
              <div class="bd"><div class="t1">${esc(d.question)}</div>
              <div class="t2">当时定的是：${esc(S.labels.answer[d.answer])}${d.condition ? "（" + esc(d.condition) + "）" : ""} · 范围 ${esc(d.scope)}</div></div></div>`).join("")
          : `<div class="empty">决定库里没有相关的。别拿「以前定过」当理由。</div>`;
        return;
      }
      if (verb === "read") {
        const v = $(`#cv-${arg}`).value;
        const r = await api(`/api/criteria/${arg}/evaluate`, "POST", { value: v });
        toast(`读数 → ${r.verdict}`);
        await reload(); return;
      }
      if (["doing", "review", "blocked", "pass", "fail"].includes(verb)) {
        const id = Number(arg);
        if (verb === "pass" || verb === "fail") {
          await api(`/api/cards/${id}/verdict`, "POST", { verdict: verb === "pass" ? "pass" : "fail", verifier: "S" });
          toast(verb === "pass" ? "验收通过" : "已退回重做");
        } else {
          await api(`/api/cards/${id}/status`, "POST", { status: verb });
          toast("状态已改");
        }
        closeDrawer(); await reload(); return;
      }
      if (["agree", "conditional", "reject", "defer"].includes(verb)) {
        let condition = null;
        if (verb === "conditional") {
          condition = prompt("附条件同意的条件是什么？（必填）");
          if (!condition) return toast("附条件必须写条件", true);
        }
        await api(`/api/decisions/${arg}/answer`, "POST", { answer: verb, condition });
        toast("已记进决定库");
        closeDrawer(); await reload(); return;
      }
      if (verb === "beat") {
        await api(`/api/agents/${arg}/heartbeat`, "POST", {});
        toast("心跳已打"); closeDrawer(); await reload(); return;
      }
      if (verb === "pause") {
        await api(`/api/agents/${arg}/heartbeat`, "POST", { alive: false });
        toast("已熄灯（黄灯）"); closeDrawer(); await reload(); return;
      }
      if (verb === "askdec") {
        const c = S.cards.find((x) => x.id === Number(arg));
        closeDrawer();
        const q1 = prompt("① 要定什么", c ? c.title : "");
        if (!q1) return;
        const q2 = prompt("② 它建议什么");
        const q3 = prompt("③ 代价是什么");
        const q4 = prompt("④ 批的范围多大", c ? c.deliverable : "");
        const q5 = prompt("⑤ 我不回会怎样", "不回 = 不做，不花钱。");
        await api(`/api/cards/${arg}/request-decision`, "POST", {
          question: q1, recommendation: q2, cost: q3, scope: q4, silent_default: q5, asked_by: c ? c.owner : "ceo",
        });
        toast("已提到我桌上，没过之前它动不了");
        await reload(); return;
      }
    } catch (err) { toast(err.message, true); }
    return;
  }

  if (e.target.id === "drawer-close" || e.target.id === "scrim") closeDrawer();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (CATE_OPEN) { CATE_OPEN = false; render(); return; }
    closeDrawer();
  }
});

// 选品页：按采集源过滤
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "pk-src") {
    MARKET_SRC = e.target.value || "";
    render();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "q") return;
  const q = e.target.value.trim().toLowerCase();
  $$("#view .tcard").forEach((el) => { el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none"; });
});

/* ── 派活对话框 ───────────────────────── */

// 任务候选：先用它自己开出的活（payload.tasks 本身就是任务式），
// 再补上「数据缺口」和「花钱」两类固定项。每条都带级别、依据、交付物、判据。
function suggestionsFor(agentId) {
  const ag = S.agents.find((x) => x.id === agentId);
  const p = (() => { try { return ag && ag.last_report && ag.last_report.payload_json ? JSON.parse(ag.last_report.payload_json) : {}; } catch { return {}; } })();
  const out = [];

  // 台账里已有的未结卡（按标题归一化比对），用来防重复派
  const openCards = (S.cards || []).filter((c) => !["done", "cancelled"].includes(c.status));
  const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[：:·\-—]/g, "");
  const openByTitle = new Map();
  for (const c of openCards) openByTitle.set(norm(c.title), c);

  for (const t of (p.tasks || []).slice(0, 5)) {
    if (!t || !t.title) continue;
    // 「示例店铺 · 近30天：盘清 8 个重复链接」→ 「盘清 8 个重复链接」，店名和窗口另存
    const raw = String(t.title);
    const cut = raw.lastIndexOf("：");
    const head = cut > 0 ? raw.slice(0, cut) : "";
    const short = cut > 0 ? raw.slice(cut + 1) : raw;
    const dup = openByTitle.get(norm(short)) || openByTitle.get(norm(raw));
    out.push({
      level: t.level || "P1",
      kind: head || "它开的活",
      title: short,
      dispatched: dup ? dup.id : null,
      why: String(t.why || ""),
      del: String(t.deliverable || "一份可核对的交付物"),
      def: String(t.done_def || ""),
      day: Number(t.check_day) || 7,
    });
  }

  const f = p.facts || {};
  if (f.adSpend != null && f.adRatio != null && out.length < 6) {
    out.push({
      level: "P1",
      kind: "花钱止损",
      title: "停掉费比高于毛利率的投放计划",
      dispatched: (openByTitle.get(norm("停掉费比高于毛利率的投放计划")) || {}).id || null,
      why: "这一窗投放 ¥" + f.adSpend + "，费比 " + f.adRatio + "%；费比高于毛利率就是在亏钱",
      del: "停投清单，加停投前后各 7 天的费比与毛利对照",
      def: "停投后 7 天费比降到毛利率以下，且成交额跌幅不超过 30%",
      day: 7,
    });
  }

  out.push({
    level: "P1",
    kind: "补数据",
    title: "填上每单物流 + 包装成本（包邮填 0）",
    dispatched: (openByTitle.get(norm("填上每单物流 + 包装成本（包邮填 0）")) || {}).id || null,
    why: "现在是空值，所有毛利率都没扣运费，结论偏乐观",
    del: "参数页里两个数字，加重算后的毛利",
    def: "参数页两个字段非空，分析报告里不再出现「物流/包装未填」",
    day: 2,
  });

  return out;
}

function openDlg(preset = {}) {
  $("#f-owner").innerHTML = S.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  if (preset.owner) {
    // 从店铺行进来的：直接把 owner 预选成这家店，标题里也带上店名
    if (![...$("#f-owner").options].some((o) => o.value === preset.owner)) {
      $("#f-owner").innerHTML += `<option value="${esc(preset.owner)}">${esc(preset.owner)}</option>`;
    }
    $("#f-owner").value = preset.owner;
  }
  if (preset.title) $("#f-title").value = preset.title;
  if (preset.why) $("#f-why").value = preset.why;
  // 竖排任务清单：一眼能看出「这条活是什么、为什么、交什么、怎么算完」
  const box = $("#f-sug");
  if (box) {
    const list = suggestionsFor(preset.owner || $("#f-owner").value);
    box.innerHTML = list.map((s, i) => `
      <button type="button" class="sugitem${s.dispatched ? " done" : ""}" data-sug="${i}">
        <input type="checkbox" class="sugchk" data-chk="${i}" ${s.dispatched ? "disabled" : "checked"} />
        <span class="suglv ${esc(s.level)}">${esc(s.level)}</span>
        <span class="sugbody">
          <b>${esc(s.title)} ${s.dispatched ? '<em class="sugdone">已派出 #' + s.dispatched + "</em>" : ""}</b>
          <i>${esc(s.kind)}</i>
          <i>交：${esc(s.del)}</i>
          <i>算完成：${esc(s.def)}</i>
        </span>
      </button>`).join("");

    const applySug = (s) => {
      if (!s) return;
      $("#f-title").value = s.title;
      $("#f-why").value = s.why;
      $("#f-del").value = s.del;
      $("#f-def").value = s.def;
      if ($("#f-level")) $("#f-level").value = s.level;
      if ($("#f-day")) $("#f-day").value = s.day;
      box.querySelectorAll(".sugitem").forEach((el) => el.classList.toggle("on", el.dataset.sug === String(list.indexOf(s))));
    };
    const syncBulk = () => {
      const n = box.querySelectorAll(".sugchk:checked").length;
      const btn = $("#f-bulk");
      if (btn) {
        btn.textContent = n ? `把勾选的 ${n} 条一起派出` : "先勾选要派的活";
        btn.disabled = n === 0;
      }
    };
    box.onclick = (e) => {
      const chk = e.target.closest(".sugchk");
      if (chk) { e.stopPropagation(); syncBulk(); return; }
      const b = e.target.closest("[data-sug]");
      if (!b) return;
      applySug(list[Number(b.dataset.sug)]);
    };
    window.__sugList = list;
    window.__syncBulk = syncBulk;
    const t = String($("#f-title").value || "").trim();
    const firstNew = list.find((x) => !x.dispatched) || null;
    if (list.length && (!t || t.endsWith("："))) applySug(firstNew || list[0]);
    syncBulk();
  }
  $("#dlg").showModal();
}

$("#dlg-cancel").addEventListener("click", () => $("#dlg").close());

// 批量派活：把清单里勾选的活一次性开成卡（每张卡的负责人/级别/回看天数取它自己的）
const bulkBtn = $("#f-bulk");
if (bulkBtn) {
  bulkBtn.addEventListener("click", async () => {
    const box = $("#f-sug");
    const list = window.__sugList || [];
    const picked = [...box.querySelectorAll(".sugchk:checked")]
      .map((c) => list[Number(c.dataset.chk)])
      .filter((s) => s && !s.dispatched);
    if (!picked.length) return toast("先勾选要派的活", true);

    const owner = $("#f-owner").value;
    const okIds = [];
    const fail = [];
    bulkBtn.disabled = true;
    bulkBtn.textContent = `正在派 ${picked.length} 张…`;
    for (const s of picked) {
      try {
        const r = await api("/api/cards", "POST", {
          title: s.title,
          why: s.why,
          deliverable: s.del,
          done_def: s.def,
          level: s.level,
          owner,
          check_day: s.day,
          actor: "ceo",
        });
        okIds.push(r.id ?? "?");
      } catch (e) {
        fail.push(s.title.slice(0, 12) + "：" + e.message);
      }
    }
    $("#dlg").close();
    if (okIds.length) toast(`派出 ${okIds.length} 张：第 ${okIds.join("、")} 号`);
    if (fail.length) toast(`${fail.length} 张没派出去：${fail[0]}`, true);
    await reload();
  });
}
$("#dlg-ok").addEventListener("click", async () => {
  const body = {
    title: $("#f-title").value.trim(),
    why: $("#f-why").value.trim(),
    deliverable: $("#f-del").value.trim(),
    done_def: $("#f-def").value.trim(),
    level: $("#f-level").value,
    owner: $("#f-owner").value,
    check_day: Number($("#f-day").value),
    actor: "ceo",
  };
  try {
    await api("/api/cards", "POST", body);
    $("#dlg").close();
    toast("派出去了");
    await reload();
  } catch (err) { toast(err.message, true); }
});

/* ── 经营参数（类目扣点 / 物流 / 包装 / 每个款拿货成本）────── */

async function openCostDlg(shopId) {
  // 没指定店铺就用第一家（真实店铺优先）
  const shops = (SHOPS.shops || []);
  // 默认挑「有商品清单、订单最多」的那家 —— 别挑到演示店
  const byData = shops.slice().sort((a, b) => (b.product_count || 0) - (a.product_count || 0)
    || (b.order_count || 0) - (a.order_count || 0));
  const pick = shopId || byData[0]?.agent || shops.find((s) => s.mode === "browser")?.agent;
  if (!pick) { toast("还没有店铺，先开一个", true); return; }

  let data;
  try { data = await api(`/api/ecom/config?shop=${encodeURIComponent(pick)}`); }
  catch (e) { toast(e.message, true); return; }

  const cfg = data.config || {};
  const shop = shops.find((s) => s.agent === pick);
  const items = cfg.items || {};

  $("#c-shopname").textContent = shop ? `${shop.platform_name} · ${shop.name}` : pick;
  $("#costdlg").dataset.shop = pick;

  // 扣点：能实算就自动显示，不用你填
  const derived = data.derivedFee;
  const feeEl = $("#c-fee");
  if (cfg.categoryFeeRate) {
    feeEl.value = (Number(cfg.categoryFeeRate) * 100).toFixed(2);
    feeEl.placeholder = "已手填";
  } else if (derived && derived.rate > 0) {
    feeEl.value = "";
    feeEl.placeholder = `自动 ${(derived.rate * 100).toFixed(2)}%`;
    feeEl.title = `实算自 ${derived.orders} 单真实订单：买家支付 ¥${derived.gmv}，商家收入 ¥${derived.income}。留空就用这个。`;
  } else {
    feeEl.value = "";
    feeEl.placeholder = "未填";
  }
  $("#c-pay").value = cfg.paymentFeeRate != null ? (Number(cfg.paymentFeeRate) * 100).toFixed(2) : "0.6";
  // 手续费行业通用 0.6%，保留但标注不用改
  $("#c-pay").title = "支付通道手续费，一般 0.6% 不用改";
  $("#c-ship").value = cfg.shippingPerOrder == null ? "" : cfg.shippingPerOrder;
  $("#c-pack").value = cfg.packagingPerOrder == null ? "" : cfg.packagingPerOrder;

  // 按 SKU 列（同一商品不同规格成本不同，一规格一行）
  const skus = data.skus || [];
  const grouped = new Map();
  for (const s of skus) {
    const k = s.item_id;
    const arr = grouped.get(k) || { item_id: k, title: s.title, rows: [] };
    arr.rows.push(s);
    grouped.set(k, arr);
  }

  $("#c-skus").innerHTML = skus.length
    ? [...grouped.values()].map((g) => `
        <div style="margin:10px 0 4px;font-size:11.5px;color:var(--fg3);border-top:1px solid rgba(255,255,255,.06);padding-top:8px">
          ${esc(String(g.title || "").slice(0, 34) || g.item_id)}　<span style="opacity:.6">ID ${esc(g.item_id)}</span>
        </div>
        ${g.rows.map((s) => {
          const cost = items[s.sku_id] ?? "";
          return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">
            <div style="flex:1;min-width:0;font-size:12px;color:var(--fg2)">
              ${esc(s.spec)}
              <div style="color:var(--fg3);font-size:10.5px">售价 ¥${s.price ?? "?"} · 库存 ${s.stock ?? "?"} · SKUID ${esc(s.sku_id || "无")}</div>
            </div>
            <input class="inp" data-skuid="${esc(s.sku_id || "")}" data-item="${esc(s.item_id)}" type="number" step="0.01"
              value="${cost === "" ? "" : esc(String(cost))}" placeholder="拿货价" style="width:104px" />
          </div>`;
        }).join("")}`).join("")
    : `<div style="color:var(--fg3);font-size:12px">还没有 SKU 清单 —— 先抓一次：node sync.mjs doudian-skus</div>`;

  $("#costdlg").showModal();
}

$("#c-cancel").addEventListener("click", () => $("#costdlg").close());
$("#c-ok").addEventListener("click", async () => {
  const shop = $("#costdlg").dataset.shop;
  // 留空 = null（未填）；填 0 = 真实 0（包邮）
  const num = (v) => (String(v).trim() === "" ? null : Number(v));
  const items = {};
  for (const el of document.querySelectorAll("#c-skus input[data-skuid]")) {
    if (el.value === "") continue;
    const key = el.dataset.skuid || el.dataset.item;
    if (!key) continue;
    items[key] = Number(el.value) || 0;
  }
  const body = {
    shop,
    categoryFeeRate: num($("#c-fee").value) / 100,
    paymentFeeRate: num($("#c-pay").value) / 100,
    shippingPerOrder: num($("#c-ship").value),
    packagingPerOrder: num($("#c-pack").value),
    items,
  };
  try {
    await api("/api/ecom/config", "POST", body);
    $("#costdlg").close();
    toast(`${shop} 参数已保存（${Object.keys(items).length} 个 SKU 有成本）`);
  } catch (e) { toast(e.message, true); }
});

/* ── 扫码登录对话框 ───────────────────── */

let loginTimer = null;

function openLoginDlg() {
  $("#l-site").value = "doudian";
  $("#l-url").value = "";
  $("#l-done").value = "";
  $("#l-timeout").value = "300";
  $("#l-status").textContent = "还没开始。";
  $("#l-go").textContent = "打开浏览器去扫码";
  $("#l-go").disabled = false;
  $("#logindlg").showModal();
}

$("#l-site").addEventListener("change", () => {
  const v = $("#l-site").value;
  $("#l-url").value = {
    doudian: "https://fxg.jinritemai.com/login/common",
    taobao: "https://login.taobao.com/member/login.jhtml",
    pdd: "https://mms.pinduoduo.com/login/",
  }[v] || "";
});

$("#l-cancel").addEventListener("click", () => {
  clearInterval(loginTimer);
  $("#logindlg").close();
});

$("#l-go").addEventListener("click", async () => {
  const site = $("#l-site").value === "custom" ? "custom" : $("#l-site").value;
  const body = {
    url: $("#l-url").value.trim() || undefined,
    done_url: $("#l-done").value.trim() || undefined,
    timeout: Number($("#l-timeout").value) || 300,
  };
  $("#l-go").disabled = true;
  $("#l-go").textContent = "已开窗口，去扫码…";
  $("#l-status").innerHTML = "浏览器窗口已经打开（在你桌面上找找，可能被压在这个窗口后面）。<b>码在那个窗口里</b>。";
  try {
    const r = await api(`/api/login/${encodeURIComponent(site)}`, "POST", body);
    $("#l-status").innerHTML = `${esc(r.note || "窗口已打开")}<br>正在等你扫码…`;

    clearInterval(loginTimer);
    let n = 0;
    loginTimer = setInterval(async () => {
      n++;
      try {
        const st = await api("/api/login/status");
        const s = st.sites[site];
        if (s?.ok) {
          clearInterval(loginTimer);
          $("#l-go").textContent = "✓ 已登录";
          $("#l-status").innerHTML = `✅ 会话已保存（${s.cookies} 条 cookie，${hhmm(s.login_at)}）。现在可以回店铺填「后台页面地址 + 选择器」了。`;
          toast("扫码登录成功，会话已保存");
          await reload();
        } else if (n > Math.ceil((body.timeout || 300) / 3)) {
          clearInterval(loginTimer);
          $("#l-go").disabled = false;
          $("#l-go").textContent = "再打开一次";
          $("#l-status").innerHTML = "等到超时还没检测到登录成功。重开一次，或把等待秒数调大。";
        } else {
          $("#l-status").innerHTML = `${esc(r.note || "窗口已打开")}<br>正在等你扫码…（${n * 3}s）`;
        }
      } catch {}
    }, 3000);
  } catch (e) {
    toast(e.message, true);
    $("#l-go").disabled = false;
    $("#l-go").textContent = "打开浏览器去扫码";
    $("#l-status").textContent = "打开失败：" + e.message;
  }
});

/* ── 开店对话框 ───────────────────────── */

function openShopDlg() {
  $("#s-platform").innerHTML = (SHOPS.platforms || [])
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.envs.length ? (p.creds_ready ? "（凭证齐）" : "（缺凭证）") : "（无需凭证）"}</option>`)
    .join("");
  $("#s-name").value = "";
  $("#s-path").value = "";
  $("#s-where").value = "";
  $("#s-col").value = "";
  shopHint();
  $("#shopdlg").showModal();
}

// 按「平台 + 接入方式」给一行人话提示，省得每回都翻文档
function shopHint() {
  const pid = $("#s-platform").value;
  const p = (SHOPS.platforms || []).find((x) => x.id === pid) || {};
  const api = $("#s-mode").value === "api";
  const el = $("#s-hint");
  if (!el) return;
  if (api) {
    el.innerHTML = p.envs && p.envs.length
      ? `官方 API 需要环境变量：<code>${p.envs.join("</code> <code>")}</code> —— 设完 <b>重开终端</b>，再点店铺卡上的「试连」。`
      : `这个平台没有官方 API 连接器，走 CSV 更省事。`;
    $("#s-metric").value = p.metric || "待发货订单";
  } else if ($("#s-mode").value === "browser") {
    el.innerHTML = `浏览器接入：扫码登录一次，之后它自己开页面读那个数。<br>
      选择器在 F12 里选中数字 → 右键 Copy → Copy selector，别猜。`;
  } else {
    el.innerHTML = `CSV 模式：把后台导出的表放到 <code>${esc($("#s-path").value || "data/" + (p.id || "shop") + "-orders.csv")}</code>，点「试连」就读到了。`;
  }
}

function shopModeToggle() {
  const m = $("#s-mode").value;
  $("#s-csv-box").style.display = m === "csv" ? "" : "none";
  $("#s-web-box").style.display = m === "browser" ? "" : "none";
  shopHint();
}
$("#s-mode").addEventListener("change", shopModeToggle);
$("#s-platform").addEventListener("change", () => {
  const p = (SHOPS.platforms || []).find((x) => x.id === $("#s-platform").value) || {};
  $("#s-metric").value = p.metric || "待发货";
  if (!$("#s-site").value) $("#s-site").value = ($("#s-platform").value || "shop").replace(/-shop$/, "") || "shop";
  shopHint();
});

// 扫码登录：让服务端在桌面上开一个有头浏览器
$("#s-login").addEventListener("click", async () => {
  const site = ($("#s-site").value.trim() || "doudian");
  const url = $("#s-url").value.trim() || undefined;
  $("#s-login").textContent = "已弹窗，去扫码…";
  $("#s-login").disabled = true;
  try {
    const r = await api(`/api/login/${encodeURIComponent(site)}`, "POST", { url, timeout: 300 });
    toast(r.note || "浏览器已打开，扫码登录");
    // 每 3 秒看一次登录状态
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const st = await api("/api/login/status");
        const s = st.sites[site];
        if (s?.ok) {
          clearInterval(t);
          $("#s-login").textContent = "✓ 已登录";
          toast(`会话已保存（${s.cookies} 条 cookie）`);
        } else if (n > 40) {
          clearInterval(t);
          $("#s-login").textContent = "扫码登录一次";
          $("#s-login").disabled = false;
        }
      } catch {}
    }, 3000);
  } catch (e) {
    toast(e.message, true);
    $("#s-login").textContent = "扫码登录一次";
    $("#s-login").disabled = false;
  }
});
$("#s-path").addEventListener("input", () => { if ($("#s-mode").value === "csv") shopHint(); });
$("#s-cancel").addEventListener("click", () => $("#shopdlg").close());
$("#s-ok").addEventListener("click", async () => {
  const mode = $("#s-mode").value;
  const how = $("#s-how").value;
  const body = {
    name: $("#s-name").value.trim(),
    platform: $("#s-platform").value,
    mode,
    metric: $("#s-metric").value.trim() || "待发货",
  };
  if (mode === "csv") {
    body.path = $("#s-path").value.trim() || undefined;
    body.where = $("#s-where").value.trim() || undefined;
    if (how === "count") body.count = true;
    if (how === "sum") body.sum = $("#s-col").value.trim() || "amount";
    if (how === "value") body.value = $("#s-col").value.trim() || "amount";
  }
  if (mode === "browser") {
    body.url = $("#s-url").value.trim() || undefined;
    body.selector = $("#s-selector").value.trim() || undefined;
    body.site = $("#s-site").value.trim() || undefined;
    body.wait = Number($("#s-wait").value) || 8000;
    if (!body.url || !body.selector) return toast("浏览器接入要填：后台地址 + 选择器", true);
  }
  try {
    const r = await api("/api/shops", "POST", body);
    $("#shopdlg").close();
    toast(`开好了：${r.shop.name}（Agent ${r.shop.agent}）`);
    if (r.needFile) toast(`把报表放到 ${r.needFile}，然后点「试连」`);
    await reload();
    currentTab = "shops";
    render();
  } catch (err) { toast(err.message, true); }
});

/* ── 启动 ─────────────────────────────── */

async function reload() {
  S = await api("/api/state");
  try { PROFILE = await api("/api/profile"); } catch {}
  try { ACT = (await api("/api/activity?limit=12")).items; } catch { ACT = []; }
  try { SHOPS = await api("/api/shops"); } catch {}
  try {
    const c = await api("/api/connectors");
    ALL_CONNS = c.connectors;
    OSS_CONNS = c.connectors.filter((x) => x.agent === "oss");
  } catch { ALL_CONNS = []; OSS_CONNS = []; }
  render();
}

window.addEventListener("resize", () => requestAnimationFrame(drawFan));

// 地址栏带页签：#shops / #tasks / #approvals …… 直接打到那一页，可收藏可分享
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (t && t !== currentTab) { currentTab = t; render(); }
});

const VALID_TABS = ["overview", "brief", "tasks", "approvals", "criteria", "shops", "audit", "pipeline", "tc", "todo"];
if (VALID_TABS.includes(location.hash.slice(1))) currentTab = location.hash.slice(1);

reload().then(connectStream);

// 模型接入面板（懒加载实例，点顶栏「模型接入」时用）
const openAiDialog = window.initAiDialog ? window.initAiDialog({ api, toast, $ }) : null;
