/**
 * connectors/buyin-hot.mjs —— 精选联盟「联盟榜单」采集（走官方接口，不扒 DOM）
 *
 * 页面：https://buyin.jinritemai.com/dashboard/merch-picking-hall/rank
 * 接口（登录态 cookie 走同一浏览器上下文）：
 *   POST /pc/leaderboard_26/get_board_default_info   榜单定义 + 完整类目树
 *   POST /pc/leaderboard_26/board_pmt                榜单数据（分页 cursor/count）
 *     body: { rank_type, date_type, genre_type, cate_id, cate_level, industry_id, cursor, count }
 *       rank_type: sale(爆款榜) | trend(趋势榜) | ...
 *       date_type: realtime(实时) | 1d(昨日) | 7d | 30d
 *       cate_id=-1&cate_level=-1&industry_id=-1 → 全类目总榜
 *
 * 为什么改成接口：DOM 里那张表的「热销」列名会随时间窗变（实时=近2小时热销 / 昨日=昨日热销），
 * 类目 chip 还藏在二级下拉里点不到。接口一次给全：排名、近2小时销量、月销、佣金率、每单赚、
 * 店铺评分，还有 30 天逐日销量（sale_axis）——这些扒 DOM 都拿不到或拿不全。
 *
 * 真实性纪律：
 *   ① 时间窗由 date_type 和返回里的 board_sale.content 双重确认，不一致就报错。
 *   ② 拿不到就 ok:false，不填假数。
 *   ③ 类目名找不到就列出接口返回的可用类目，不猜。
 *
 * connectors.json：
 *   { "id":"buyin-hot",     "category":"食品饮料", "window":"实时" }
 *   { "id":"buyin-hot-all", "category":"全类目",   "window":"实时" }
 * 调试：PROBE=1 node sync.mjs buyin-hot-all  → 打印类目树和一条样本，不写库
 */

import fs from "node:fs";
import path from "node:path";
import { openProfile } from "./_browser.mjs";

const PROBE = process.env.PROBE === "1";
const API = "https://buyin.jinritemai.com/pc/leaderboard_26/";
const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);
const isAllCate = (c) => !c || /^(全类目|全部|全部类目|\*|all)$/i.test(String(c).trim());

const WIN_MAP = { "实时": "realtime", realtime: "realtime", "昨日": "1d", "近7日": "7d", "近30日": "30d", "近1天": "1d" };
const RANK_MAP = { "爆款榜": "sale", "趋势榜": "trend", "带货榜": "author", "常销榜": "steadyw", sale: "sale", trend: "trend" };
const WIN_BACK = { realtime: "实时", "1d": "昨日", "7d": "近7日", "30d": "近30日" };

// 类目树拍平：name → {id, level, root}
//   root = 所属「一级类目」的 cate_id。
//   实测：二级类目（休闲食品 1000000724 / L1）如果 industry_id 填自己，接口返回空榜单；
//   必须填父级（食品饮料 13）。所以这里把一级祖先一起记下来。
function flattenCates(nodes, out = new Map(), rootId = null, depth = 0) {
  for (const n of nodes || []) {
    if (!n.cate_name) continue;
    const isTop = n.cate_level === 0;
    const root = isTop || n.cate_level === -1 ? n.cate_id : (rootId ?? n.cate_id);
    if (!out.has(n.cate_name)) {
      out.set(n.cate_name, { id: n.cate_id, level: n.cate_level, root, depth });
    }
    flattenCates(n.child_cate_list, out, root, depth + 1);
  }
  return out;
}

export default {
  id: "buyin-hot",
  agent: "pick",
  async run(cfg) {
    const site = cfg.site || "buyin";
    const category = String(cfg.category ?? "食品饮料");
    const allCate = isAllCate(category);
    const winWanted = String(cfg.window ?? "实时");
    const dateType = WIN_MAP[winWanted] || "realtime";
    const rankType = RANK_MAP[String(cfg.rankType ?? "爆款榜")] || "sale";
    const count = Math.min(50, Number(cfg.pageSize || 20));
    const maxItems = Math.min(500, Number(cfg.maxItems || 100));

    const ctx = await openProfile(site, { headless: true }).catch((e) => { globalThis.__e = e.message; return null; });
    if (!ctx) return { ok: false, error: globalThis.__e || "打不开 profile（node login.mjs --site buyin）" };

    const post = async (api, body) => {
      const r = await ctx.request.post(API + api, {
        data: body, headers: { "content-type": "application/json" }, timeout: 30000,
      }).catch((e) => ({ json: async () => ({ code: -1, msg: String(e.message) }) }));
      return r.json().catch(() => ({ code: -1, msg: "返回不是 JSON" }));
    };

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://buyin.jinritemai.com/dashboard/merch-picking-hall/rank", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3500);
      if (/login|passport|sso|signin/i.test(page.url())) return { ok: false, error: "精选联盟没登录 → node login.mjs --site buyin" };

      const def = await post("get_board_default_info", {});
      if (def.code !== 0) return { ok: false, error: `榜单定义接口失败：${def.msg || def.code}（多半是登录态过期）` };
      const cateMap = flattenCates(def?.data?.industry_list || []);

      // 把真实类目树落成本地文件，界面下拉直接读它 —— 不给用户一个「猜类目名」的输入框
      try {
        const list = [...cateMap.entries()].map(([name, v]) => ({ name, id: v.id, level: v.level, depth: v.depth }));
        fs.writeFileSync(
          path.join(import.meta.dirname, "..", "data", "buyin-cates.json"),
          JSON.stringify({ at: new Date().toISOString(), source: "精选联盟 联盟榜单 类目树", list }, null, 1),
          "utf8"
        );
      } catch {}

      let cateArg = { cate_id: -1, cate_level: -1, industry_id: -1 };
      if (!allCate) {
        const hit = cateMap.get(category);
        if (!hit) {
          const names = [...cateMap.keys()].slice(0, 40).join(" / ");
          return { ok: false, error: `类目「${category}」不在接口返回的类目树里。可用：${names}` };
        }
        cateArg = { cate_id: hit.id, cate_level: hit.level, industry_id: hit.root };
      }

      const items = [];
      let cursor = 0, total = null, guard = 0;
      const runAt = new Date().toISOString();
      while (items.length < maxItems && guard++ < 30) {
        const body = { rank_type: rankType, date_type: dateType, genre_type: cfg.genre || "all", ...cateArg, cursor, count };
        const r = await post("board_pmt", body);
        if (r.code !== 0) return { ok: false, error: `榜单接口失败：${r.msg || r.code}` };
        const d = r.data || {};
        total = d.count ?? total;
        const list = d.summary_promotions || [];
        if (!list.length) break;

        for (const it of list) {
          const bi = it.base_model || {};
          const bd = it.custom_model?.selection_square_model?.board_data || {};
          const pi = bi.product_info || {};
          const cos = bi.promotion_info?.cos_info?.cos || {};
          const price = bi.marketing_info?.price_desc?.price?.origin;
          const shop = bi.shop_info?.shop_name || null;
          const score = bi.shop_info?.shop_score_info?.shop_score?.score ?? null;

          items.push({
            source: allCate ? "精选联盟·爆款榜(全类目)" : `精选联盟·爆款榜(${category})`,
            category: allCate ? "全类目" : category,
            rank_window: `${WIN_BACK[dateType] || dateType}｜${bd.board_sale?.content || "热销"}`,
            title: String(pi.name || "").slice(0, 160),
            price: price == null ? null : Number(price) / 100,
            sales_2h: bd.board_sale?.sale_num ?? null,
            commission_rate: cos.cos_ratio?.origin ?? null,
            shop,
            item_id: String(it.product_id || it.promotion_id || ""),
            raw: JSON.stringify({
              kind: "buyin-api", rank: bd.rank ?? null, sale_label: bd.board_sale?.content || null,
              hot_sales: bd.board_sale?.sale_num ?? null,
              month_sales: pi.month_sale?.origin ?? null,
              commission_rate: cos.cos_ratio?.origin ?? null,
              // cos_fee 单位是「分」：¥13.9 的 5% 接口给 70 → 0.70 元，别当成 70 元
              earn_per_order: cos.cos_fee?.origin == null ? null : Number(cos.cos_fee.origin) / 100,
              price_yuan: price == null ? null : Number(price) / 100,
              shop, shop_score: score,
              product_id: it.product_id, promotion_id: it.promotion_id,
              detail_url: pi.detail_url || null,
              sale_axis: pi.sale_axis || null,
              rank_type: rankType, date_type: dateType,
              cate: allCate ? "全类目" : category,
            }),
            // 整批共用一个时间戳：按「本批」统计时才能用 fetched_at 分组，
            // 每条各取一次 new Date() 会让同一批变成 100 个不同时间。
            fetched_at: runAt,
          });
        }
        if (!d.has_more) break;
        cursor += list.length;
      }

      const withHot = items.filter((x) => x.sales_2h != null).length;
      if (!items.length) return { ok: false, error: "接口返回空榜单（窗口/类目组合可能无数据）" };

      // 榜单总量（接口 count）回填进每条 raw，前端卡片就能显示「共 520 条，抓了 100 条」
      if (total != null) {
        for (const it of items) {
          try {
            const r = JSON.parse(it.raw);
            r.board_total = total;
            it.raw = JSON.stringify(r);
          } catch {}
        }
      }

      if (PROBE) {
        const out = { total, head: items.slice(0, 2), cates: [...cateMap.entries()].slice(0, 50) };
        fs.writeFileSync(path.join(import.meta.dirname, "..", "logs", "buyin-api-probe.json"), JSON.stringify(out, null, 2), "utf8");
        console.log("[PROBE] 总数:", total, "· 抓到:", items.length);
        console.log("[PROBE] 样本:", JSON.stringify(items.slice(0, 2), null, 1).slice(0, 900));
        return { ok: true, value: "probe", extra: "probe 不写库", report: "精选联盟接口探测" };
      }

      return {
        ok: true,
        value: `${items.length} 条`,
        extra: `精选联盟·${String(cfg.rankType ?? "爆款榜")} · ${allCate ? "全类目" : category} · ${WIN_BACK[dateType] || dateType}`
          + ` · 热销有值 ${withHot}/${items.length}` + (total ? ` · 榜单共 ${total}` : "") + ` · ${localHM()}`,
        market: items,
        report: `精选联盟榜单 ${items.length} 条（${allCate ? "全类目" : category} · ${WIN_BACK[dateType] || dateType}，热销有值 ${withHot}）`,
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
