/**
 * agent-worker.mjs —— AI 领卡干活（干完交给你审核）
 *
 * 一条卡进来，它做三件事：
 *   1. 判：这张卡 AI 能不能干（分析/算数/写方案 = 能；点后台按钮 = 不能）
 *   2. 干：能的就真干 —— 把库里的事实喂给模型，产出交付物文件
 *   3. 交：写进卡片（交活 + 证据路径），卡自动进「待验收」，等你判 pass/fail
 *
 * 用法：
 *   node agent-worker.mjs                # 领所有能干的分析类卡
 *   node agent-worker.mjs --card 48      # 只干某一张
 *   node agent-worker.mjs --dry          # 只判不干，看它认为哪些能干
 *
 * 铁律：模型只能引用喂给它的 FACTS，不许自己编数；缺数就写「缺」。
 */

import fs from "node:fs";
import { db } from "./db.mjs";
import { classifyCategory, getPolicy } from "./policy-matrix.mjs";

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const SHOP = "shop_demo";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes("--" + k);
const DRY = flag("dry");
const ONLY = arg("card") ? Number(arg("card")) : null;

const ai = JSON.parse(fs.readFileSync(new URL("./ai.config.json", import.meta.url), "utf8"));
const llm = ai.llm || {};
if (!llm.api_key || llm.api_key === "<set>") {
  console.error("没配 LLM 密钥：先在界面「模型接入」里填 DeepSeek key");
  process.exit(1);
}

const y = (n) => `¥${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

// ── 事实包：只喂真数 ────────────────────────────────
function facts() {
  const cfgRaw = JSON.parse(fs.readFileSync(new URL("./ecom.config.json", import.meta.url), "utf8"));
  const cfg = { ...(cfgRaw.defaults || {}), ...((cfgRaw.shops || {})[SHOP] || {}) };
  const items = cfg.items || {};
  const sets = db.prepare("SELECT * FROM settlements WHERE shop = ?").all(SHOP);
  const orders = db.prepare("SELECT * FROM orders WHERE shop = ?").all(SHOP).filter((o) => !/关闭|取消|退款/.test(o.status || ""));
  const skus = db.prepare("SELECT * FROM skus WHERE shop = ?").all(SHOP);
  const fee = db.prepare("SELECT rate, samples, category FROM fee_rates WHERE shop = ? ORDER BY samples DESC LIMIT 1").get(SHOP);

  const specOf = (s) => (String(s || "").match(/【([^】]+)】/) || [])[1] || null;
  const skuBySpec = new Map();
  for (const s of skus) { const k = specOf(s.spec) || String(s.spec).trim(); if (k) skuBySpec.set(k, s); }

  // 按规格汇总（用结算账单的真实钱）
  const agg = new Map();
  const omap = new Map(orders.map((o) => [String(o.order_id), o]));
  for (const s of sets) {
    const o = omap.get(String(s.order_id));
    const spec = o ? (specOf(o.sku) || "未知") : "未知";
    const qty = o ? Number(o.qty) || 1 : 1;
    const c = skuBySpec.get(spec);
    const cost = c && items[c.sku_id] ? Number(items[c.sku_id]) * qty : null;
    const a = agg.get(spec) || { spec, orders: 0, units: 0, paid: 0, subsidy: 0, settle: 0, cost: 0, miss: 0 };
    a.orders += 1; a.units += qty;
    a.paid += Number(s.paid) || 0;
    a.subsidy += Number(s.subsidy) || 0;
    a.settle += Number(s.settle_amount) || 0;
    if (cost == null) a.miss += qty; else a.cost += cost;
    agg.set(spec, a);
  }
  const perSku = [...agg.values()].map((a) => ({
    规格: a.spec, 单数: a.orders, 件数: a.units,
    用户实付: +a.paid.toFixed(2), 平台补贴: +a.subsidy.toFixed(2),
    结算到账: +a.settle.toFixed(2), 拿货: +a.cost.toFixed(2),
    每单均价: a.orders ? +(a.paid / a.orders).toFixed(2) : null,
    每单到手: a.orders ? +(a.settle / a.orders).toFixed(2) : null,
    每单成本: a.units ? +(a.cost / a.units).toFixed(2) : null,
    每单毛利: a.units && a.miss === 0 ? +((a.settle - a.cost) / a.orders).toFixed(2) : null,
  }));

  const snap = db.prepare("SELECT win, label, value, ok FROM metric_snapshots WHERE agent_id = ?").all(SHOP);
  const metric = (win, label) => {
    const r = snap.find((x) => x.win === win && x.label === label);
    return r && r.ok && r.value !== "-" ? Number(String(r.value).replace(/[^\d.-]/g, "")) : null;
  };

  return {
    店铺: "示例店铺（抖店个体店）",
    类目费率: fee ? { 费率: fee.rate, 样本笔数: fee.samples, 类目: fee.category } : "缺",
    物流包装: cfg.shippingPerOrder == null && cfg.packagingPerOrder == null ? "未填（包邮应填 0）" : { 物流: cfg.shippingPerOrder, 包装: cfg.packagingPerOrder },
    已结算账单: { 笔数: sets.length, 用户实付: +sets.reduce((s, x) => s + (Number(x.paid) || 0), 0).toFixed(2), 平台服务费: +sets.reduce((s, x) => s + Math.abs(Number(x.service_fee) || 0), 0).toFixed(2) },
    按规格: perSku,
    近30天: {
      成交: metric("近30天", "成交金额"),
      订单数: metric("近30天", "成交订单数"),
      投放: metric("近30天", "投放消耗"),
      费比: metric("近30天", "投放费比"),
      退款: metric("近30天", "退款金额"),
    },
    数据边界: [
      "订单能关联到商品ID 的比例极低，所以「哪个链接卖得好」目前不可判断",
      "账单只含已结算订单（账期3天），在途未含",
      "物流/包装未填时，所有毛利率都没扣运费",
    ],
  };
}

// ── 判：这张卡 AI 能不能干 ──────────────────────────
function classify(card) {
  const title = String(card.title || "");
  const deliverable = String(card.deliverable || "") + " " + String(card.done_def || "");

  // ① 标题就是「去后台动手」的活 —— AI 替不了
  if (/发货|下架|上架|改价|改标题|换主图|上传|扫码|登录|拍照|打包|寄件|处理完|填上|填经营|填每单/.test(title)) {
    return { mode: "human", why: "要在抖店后台动手或涉及实物/真实数字，AI 替不了" };
  }
  // ② 交付物是「表 / 数据 / 方案 / 对比 / 清单」 —— AI 能出，人审
  if (/表|数据|方案|对比|清单|结论|测算|复盘/.test(deliverable)) {
    return { mode: "ai", why: "要的是分析型交付物，AI 出内容，你审" };
  }
  // ③ 拿不准就交给人，不给 AI 瞎判
  return { mode: "human", why: "交付物不是分析型的，保守交给人" };
}

// ── 能力路由：这类卡该用哪个执行器 ────────────────────
// 改标题 / 文案  → make-copy.mjs
// 主图 / 详情页图 → make-image.mjs
// 其它分析类     → 直接问模型写文档（doWork）
function workerOf(card) {
  const t = String(card.title) + " " + String(card.deliverable || "");
  if (/主图|详情图|详情页图|出图|配图/.test(t)) return { kind: "image", type: /详情/.test(t) ? "detail" : "main" };
  if (/标题|文案|长尾词|卖点/.test(t)) return { kind: "copy", type: /详情页|详情/.test(t) ? "detail" : "title" };
  return { kind: "doc" };
}

// ── 干：模型产出交付物 ──────────────────────────────
async function doWork(card, factsObj) {
  const sys = `你是示例店铺的电商运营。现在领到一张卡，要交出可验收的交付物。
铁律：
1. 只能引用我给你的 FACTS 里的数字，一个都不许自己编。FACTS 里没有的，写「缺」。
2. 给结论必须能算：每个建议后面跟一个数字依据。
3. 不确定就说不确定，不要为了好看硬给结论。
4. 输出 Markdown，直接是交付物正文，不要寒暄。`;

  const user = `【这张卡】
- 这件事：${card.title}
- 为什么做：${card.why}
- 要交什么：${card.deliverable}
- 怎么算完成：${card.done_def}

【FACTS】
${JSON.stringify(factsObj, null, 2)}

按「要交什么」交出交付物。若数据不足以完成「怎么算完成」，就在文末写「## 缺什么」并列出缺的具体数据。`;

  const res = await fetch(`${llm.base_url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.api_key}` },
    body: JSON.stringify({
      model: llm.model || "deepseek-chat",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.3,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`模型报错 ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.choices?.[0]?.message?.content || "";
}

// ── 主流程 ─────────────────────────────────────
const cards = db.prepare(
  "SELECT * FROM cards WHERE status IN ('todo','doing') ORDER BY id"
).all().filter((c) => (ONLY ? c.id === ONLY : true));

if (!cards.length) { console.log("没有待办的卡"); process.exit(0); }

const todo = [];      // 直接干的
const needAsk = [];   // 第一次遇到的类别，要问你
const humanOnly = []; // 策略=人来干

for (const c of cards) {
  const cat = classifyCategory(c.title);
  const pol = getPolicy(db, cat);
  const k = classify(c);

  console.log(`#${c.id} [${c.level}] ${String(c.title).slice(0, 32)}`);
  console.log(`   类别「${cat}」· 策略 ${pol.mode === "ask" ? "未定" : pol.mode} · 能力判定 ${k.mode === "ai" ? "AI 能干" : "只能人干"}`);

  if (pol.mode === "ask") {
    // 这类任务第一次出现：挂一张「授权请求」，问你怎么管
    needAsk.push({ card: c, cat, k });
    db.prepare("UPDATE cards SET exec_mode = 'ask', next_action = '等你定规矩', next_reason = ? WHERE id = ?")
      .run(`「${cat}」这类任务第一次出现，等你决定以后谁处理`, c.id);
    continue;
  }
  if (pol.mode === "human") {
    humanOnly.push({ card: c, cat });
    db.prepare("UPDATE cards SET exec_mode = 'human', next_action = '等对面交', next_reason = ? WHERE id = ?")
      .run(`「${cat}」按你的规矩交人处理`, c.id);
    continue;
  }
  // pol.mode === "auto"：全权处理
  if (k.mode === "ai") {
    todo.push(c);
    db.prepare("UPDATE cards SET exec_mode = 'auto' WHERE id = ?").run(c.id);
  } else {
    // 策略说全权，但这张卡要动后台 —— 只能出操作清单
    humanOnly.push({ card: c, cat });
    db.prepare("UPDATE cards SET exec_mode = 'assist', next_action = 'AI 出方案，你执行', next_reason = ? WHERE id = ?")
      .run(`「${cat}」是全权，但这张要动后台，AI 给步骤你来点`, c.id);
  }
}

// 按类别去重：同一类只问一次
const catFirst = new Map();
for (const x of needAsk) if (!catFirst.has(x.cat)) catFirst.set(x.cat, x);

if (catFirst.size) {
  console.log(`\n有 ${catFirst.size} 类任务第一次出现，各问你一次（定完以后不再问）：`);
  for (const [cat, x] of catFirst) {
    console.log(`   「${cat}」首次：#${x.card.id} ${String(x.card.title).slice(0, 26)}`);
  }

  if (!DRY) {
    for (const [cat, x] of catFirst) {
      // 已经挂过同一类的授权请求就不重复开
      const dup = db.prepare(
        "SELECT id FROM decisions WHERE answer IS NULL AND scope LIKE ?"
      ).get(`%policy:${cat}%`);
      if (dup) { console.log(`   「${cat}」已有待答的授权请求 #${dup.id}，不重复开`); continue; }

      const r = await fetch(`${BASE}/api/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: `「${cat}」这类任务以后谁处理？（例：#${x.card.id} ${String(x.card.title).slice(0, 20)}）`,
          recommendation: "建议：CEO 全权——AI 直接做完，只在台账留痕给你看；不放心就选人工",
          cost: "全权：万一做歪要回滚，但快；人工：慢，每件都占你时间",
          scope: `只管「${cat}」这一类，不波及别的类别 · policy:${cat}`,
          silent_default: "不回 = 维持现状（每次都问你），不会偷偷自动做",
          asked_by: "worker",
          card_id: x.card.id,
        }),
      });
      const j = await r.json().catch(() => ({}));
      console.log(`   「${cat}」授权请求已开：${r.status === 201 ? "#" + j.id : "失败 " + r.status}`);
    }
  }
}

if (DRY) { console.log(`\n[dry] 能干的有 ${todo.length} 张，没真干`); process.exit(0); }
if (!todo.length) { console.log("\n这批卡都要人干，AI 不插手"); process.exit(0); }

const F = facts();
console.log(`\n开始干 ${todo.length} 张…\n`);

for (const c of todo) {
  const t0 = Date.now();
  try {
    console.log(`▶ #${c.id} ${String(c.title).slice(0, 30)}…`);

    const route = workerOf(c);
    if (route.kind === "copy" || route.kind === "image") {
      const { execFileSync } = await import("node:child_process");
      const itemId = arg("item") || db.prepare("SELECT item_id FROM products WHERE shop = ? LIMIT 1").get(SHOP).item_id;
      const script = route.kind === "copy" ? "make-copy.mjs" : "make-image.mjs";
      const args = [script, "--item", itemId, "--type", route.type, "--card", String(c.id)];
      console.log(`   走执行器：${script} --type ${route.type}`);
      try {
        const out = execFileSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 240000, windowsHide: true });
        const tail = out.split("\n").filter((l) => /已写出|交活|清单|失败|出不了图/.test(l)).slice(0, 4);
        tail.forEach((l) => console.log("   " + l.trim()));
        continue;   // 执行器自己会交活
      } catch (e) {
        const msg = String(e.stdout || e.message || e);
        // 出图缺 key：这张卡的文字部分还能交，别整张卡卡死
        if (route.kind === "image" && /出不了图|API Key/.test(msg)) {
          console.log("   出图缺 key —— 先把文案部分交了，图等 key 补上再跑");
          try {
            const out2 = execFileSync(process.execPath, ["make-copy.mjs", "--item", itemId, "--type", "title", "--card", String(c.id)],
              { cwd: process.cwd(), encoding: "utf8", timeout: 180000, windowsHide: true });
            out2.split("\n").filter((l) => /已写出|交活/.test(l)).forEach((l) => console.log("     " + l.trim()));
            const imgNote = `\n\n## 还差什么\n- 主图/详情图没出：出图模型没配 key（界面「模型接入 → 图片模型」填 Nano Banana key）\n- 文案部分已交，可先审标题`;
            fs.appendFileSync(`文案_${itemId}_title.md`, imgNote, "utf8");
          } catch (e2) {
            console.log("   文案也失败：" + String(e2.message || e2).slice(0, 120));
          }
          continue;
        }
        throw e;
      }
    }

    const md = await doWork(c, F);
    if (!md || md.length < 60) throw new Error("模型返回太短，判定不可用");

    const file = `交付物_卡${c.id}.md`;
    const head = `# 卡 #${c.id} 交付物\n\n> 这件事：${c.title}\n> 怎么算完成：${c.done_def}\n> 干活：DeepSeek（领卡执行），等你验收\n\n---\n\n`;
    fs.writeFileSync(file, head + md, "utf8");

    const r = await fetch(`${BASE}/api/cards/${c.id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        by: "ai",
        note: `AI 已按「要交什么」交出交付物（${md.length} 字）`,
        evidence: file,
      }),
    });
    console.log(`   交活 ${r.status}　用时 ${((Date.now() - t0) / 1000).toFixed(1)}s　→ ${file}`);
  } catch (e) {
    console.log(`   失败：${String(e.message || e).slice(0, 160)}`);
  }
}

const left = db.prepare("SELECT id,status FROM cards WHERE status = 'review'").all();
console.log(`\n现在待你验收的卡：${left.map((x) => "#" + x.id).join(" ")}`);
