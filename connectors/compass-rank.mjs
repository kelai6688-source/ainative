/**
 * connectors/compass-rank.mjs —— 电商罗盘「市场」两个榜的采集
 *
 * 为什么要有它：选品不能只看自己店里卖过什么（那是复盘）。要判断「市场缺什么、
 * 什么在涨、谁在赚」，得有外部口径。抖店商家后台自带罗盘就有：
 *
 *   ① 市场 → 市场排行 → 商品榜单   /shop/chance/rank-product
 *      类目内 TOP 商品：价格带、店铺、支付金额区间、点击、成交件数、点击成交转化率
 *   ② 市场 → 行业机会 → 类目挖掘   /shop/chance/category-mining
 *      机会类目：成交增速、需求供给比、最高成交价格带、自然流量占比 + 「成交高第N/增速快第N/竞争小第N」
 *
 * 口径纪律（重要）：
 *   两个榜都是**区间值**（¥250万-¥500万、10万-25万），不是精确数。
 *   raw 里原样存区间文本；派生数字一律标 mid（区间中点推算），不冒充精确值。
 *
 * 解析纪律：**按表头名找列**，不按位置猜。同一个页面在不同类目/版本下列会变，
 * 按位置读会把「支付金额」当成「商品标题」——这种错比没数据更坏。
 */

import { openProfile } from "./_browser.mjs";

const num = (s) => {
  const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// "¥250万 - ¥500万" / "10万 - 25万" / "20% - 25%" / "¥19" → {lo,hi,mid,text}
function band(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const s = raw.replace(/[,，\s]/g, "");
  const toNum = (t) => {
    const v = num(t);
    if (v == null) return null;
    if (/亿/.test(t)) return v * 1e8;
    if (/万/.test(t)) return v * 1e4;
    return v;
  };
  const parts = s.split(/[-~—至]/).filter(Boolean).map(toNum).filter((x) => x != null);
  if (!parts.length) return null;
  const lo = Math.min(...parts), hi = Math.max(...parts);
  return { lo, hi, mid: (lo + hi) / 2, text: raw };
}

const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);

// 点文本匹配的元素；prefer="top" 时取页面上最靠上的那个（筛选栏在表格上面）
async function clickText(page, txt, { exact = true, wait = 1500, prefer = "short" } = {}) {
  const ok = await page.evaluate(({ t, exact, prefer }) => {
    const cands = [...document.querySelectorAll("div,span,a,li,button")]
      .filter((e) => {
        const s = (e.innerText || "").replace(/\s+/g, " ").trim();
        if (!s || s.length > 40 || e.offsetParent === null) return false;
        return exact ? s === t : s.includes(t);
      });
    if (!cands.length) return false;
    let pick;
    if (prefer === "top") {
      pick = cands.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    } else {
      pick = cands.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
    }
    pick.click();
    return true;
  }, { t: txt, exact, prefer }).catch(() => false);
  if (ok) await page.waitForTimeout(wait);
  return ok;
}

async function readTable(page) {
  return page.evaluate(() => {
    const t = [...document.querySelectorAll("table")].find((x) => (x.innerText || "").length > 200);
    if (!t) return { head: [], rows: [] };
    const head = [...t.querySelectorAll("thead th")].map((d) => (d.innerText || "").replace(/\s+/g, " ").trim());
    const rows = [...t.querySelectorAll("tbody tr")].map((r) =>
      [...r.querySelectorAll("td")].map((d) => (d.innerText || "").replace(/\s+/g, " ").trim())
    );
    return { head, rows };
  });
}

// 当前「行业类目」口径，从页面文字里读出来（读不到就 null，不编）
async function readCateScope(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ");
    const m = t.match(/行业类目\s*([^\s].{0,70}?)\s*(?:品牌类型|经营载体|商品类目|价格带|口径)/);
    return m ? m[1].trim() : null;
  });
}

// 切类目：先看当前口径对不对；不对才点级联（优先点页面上最靠上的那个「食品饮料」）
async function ensureCategory(page, wanted) {
  const want = String(wanted || "").split("/").map((s) => s.trim()).filter(Boolean);
  if (!want.length) return { applied: false, note: "没配置类目，用页面当前口径" };

  const scope = await readCateScope(page);
  if (scope && scope.includes(want[want.length - 1])) return { applied: false, note: `当前已是 ${scope}` };

  const opened = await clickText(page, want[0], { exact: true, prefer: "top", wait: 1800 });
  if (!opened) return { applied: false, note: `点不开类目级联（找不到「${want[0]}」）` };

  for (const seg of want.slice(1)) {
    const hit = await clickText(page, seg, { exact: true, wait: 1800 });
    if (!hit) return { applied: false, note: `级联里没找到「${seg}」` };
  }
  await clickText(page, "查询", { exact: true, wait: 4000 });
  const after = await readCateScope(page);
  return { applied: true, note: `切到 ${after || want.join("/")}` };
}

// 表头名 → 列下标（找不到就 -1）
function colIndex(head, names) {
  for (const n of names) {
    const i = head.findIndex((h) => h === n || h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

export default {
  id: "compass-rank",
  agent: "pick",
  async run(cfg) {
    const site = cfg.site || "doudian";
    const kind = cfg.page || "rank";
    const ctx = await openProfile(site, { headless: true }).catch((e) => { globalThis.__e = e.message; return null; });
    if (!ctx) return { ok: false, error: globalThis.__e || `打不开 profile（site=${site}）` };

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      const url = kind === "mining"
        ? "https://compass.jinritemai.com/shop/chance/category-mining"
        : "https://compass.jinritemai.com/shop/chance/rank-product";

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(6000);
      if (/login|passport|sso/i.test(page.url())) return { ok: false, error: "罗盘会话过期 → node login.mjs --site doudian" };

      const cate = await ensureCategory(page, cfg.categoryPath).catch((e) => ({ applied: false, note: String(e.message).slice(0, 60) }));
      if (kind === "rank" && cfg.window) await clickText(page, cfg.window, { exact: true, wait: 4000 });

      const scope = (await readCateScope(page)) || cfg.categoryPath || null;
      const items = [];
      const runAt = new Date().toISOString();
      const maxPages = Math.max(1, Number(cfg.maxPages || 1));

      for (let p = 1; p <= maxPages; p++) {
        if (p > 1 && !(await clickText(page, "下一页", { exact: false, wait: 4500 }))) break;
        const { head, rows } = await readTable(page);
        if (!head.length) break;

        const bodyRows = rows.filter((r) => r.length >= 4 && !head.includes(r[0]) && !/^排名$|^类目名称$/.test(r[0] || ""));
        if (!bodyRows.length) break;

        const ix = {
          rank: colIndex(head, ["排名"]),
          goods: colIndex(head, ["商品"]),
          shop: colIndex(head, ["店铺名称", "店铺"]),
          pay: colIndex(head, ["用户支付金额"]),
          click: colIndex(head, ["点击次数", "点击"]),
          sales: colIndex(head, ["成交件数", "成交订单数"]),
          cvr: colIndex(head, ["点击成交转化率", "转化率"]),
          cate: colIndex(head, ["类目名称"]),
          growth: colIndex(head, ["成交增速", "增速"]),
          dsr: colIndex(head, ["需求供给比"]),
          priceBand: colIndex(head, ["最高成交价格带", "价格带"]),
          natural: colIndex(head, ["自然流量成交占比"]),
        };
        const at = (r, i) => (i >= 0 ? (r[i] || "") : "");

        for (const r of bodyRows) {
          // 整批共用一个时间戳（见 buyin-hot.mjs 同处说明）：按「本批」统计要靠它分组
          const fetched_at = runAt;
          if (kind === "mining") {
            if (ix.cate < 0) continue;
            const nameCell = at(r, ix.cate);
            const cateName = nameCell.split(/\s+(?:成交高|增速快|竞争小)/)[0].trim();
            if (!cateName) continue;
            const hints = {
              成交高: num((nameCell.match(/成交高第\s*(\d+)\s*名/) || [])[1]),
              增速快: num((nameCell.match(/增速快第\s*(\d+)\s*名/) || [])[1]),
              竞争小: num((nameCell.match(/竞争小第\s*(\d+)\s*名/) || [])[1]),
            };
            const growth = num(at(r, ix.growth).replace("%", ""));
            const dsr = num(at(r, ix.dsr));
            items.push({
              source: "罗盘·类目挖掘",
              category: cateName,
              rank_window: cfg.window || "近7天",
              title: `${cateName}｜增速${growth ?? "?"}% 需供比${dsr ?? "?"}${hints.竞争小 ? ` 竞争小第${hints.竞争小}` : ""}`,
              price: band(at(r, ix.priceBand))?.mid ?? null,
              // 类目挖掘没有「销量」这一列；支付金额放 raw.pay_band，
              // 不要塞进 sales_2h —— 界面会把它当销量显示成「榜 37500000」，那是错的语义。
              sales_2h: null,
              commission_rate: null,
              shop: null,
              // item_id 必须稳定：SQLite 里 UNIQUE 对 NULL 不生效，留空会导致每次采集都插一条新的，
              // 一天下来同一个类目堆十几行，排行被自己刷乱。
              item_id: `cate:${cateName}`,
              raw: JSON.stringify({
                kind: "mining", cate: cateName, hints, growth,
                demand_supply_ratio: dsr,
                pay_band: band(at(r, ix.pay)),
                price_band: band(at(r, ix.priceBand)),
                natural_ratio: band(at(r, ix.natural)),
                cate_scope: scope, source_url: page.url(),
                note: "区间值原样保留；mid = 区间中点推算",
              }),
              fetched_at,
            });
          } else {
            if (ix.goods < 0) continue;
            const cell = at(r, ix.goods);
            const title = cell.replace(/\s*价格带\s*[¥￥]?\s*[\d.]+\s*$/, "").trim();
            if (!title) continue;
            items.push({
              source: "罗盘·商品榜单",
              category: scope,
              rank_window: cfg.window || "近7天",
              title: title.slice(0, 160),
              price: num((cell.match(/价格带\s*[¥￥]?\s*([\d.]+)/) || [])[1]),
              sales_2h: band(at(r, ix.sales))?.mid ?? null,
              commission_rate: null,
              shop: at(r, ix.shop) || null,
              item_id: `rank:${title.slice(0, 40)}`,
              raw: JSON.stringify({
                kind: "rank", rank_raw: at(r, ix.rank) || null, shop: at(r, ix.shop) || null,
                pay_band: band(at(r, ix.pay)), click_band: band(at(r, ix.click)),
                sales_band: band(at(r, ix.sales)), cvr_band: band(at(r, ix.cvr)),
                cate_scope: scope, source_url: page.url(),
                note: "区间值原样保留；mid = 区间中点推算",
              }),
              fetched_at,
            });
          }
        }
        if (kind !== "rank") break;
      }

      if (!items.length) {
        const txt = (await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "))).slice(0, 240);
        return { ok: false, error: `榜单没解析出数据（${cate.note}）。页面开头：${txt}` };
      }

      const label = kind === "mining" ? "类目机会" : "商品榜单";
      return {
        ok: true,
        value: `${items.length} 条`,
        extra: `罗盘·${label} · ${scope || "当前类目"} · ${cfg.window || "近7天"} · ${localHM()}`
          + (cate.applied ? `（${cate.note}）` : ""),
        market: items,
        report: `罗盘${label} ${items.length} 条（${scope || "当前类目"}）`,
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
