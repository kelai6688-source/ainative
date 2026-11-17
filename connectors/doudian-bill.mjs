// 抖店结算账单：逐笔抓「用户实付 / 补贴 / 平台服务费 / 费率 / 类目 / 结算金额」
//
// 为什么必须抓这个：
//   费率不能猜。账单备注列直接写着「平台服务费率2%;商品类目: 粮油干货/方便速食>方便速食>面皮/面饼（实物）」，
//   手填 5% 就是错的，会把毛利、保本 ROI、投放决策全带偏。
//
// 页面：/ffa/fxg-bill/fund-detail-bill → 点「结算账单」页签
// connectors.json：
//   { "id":"doudian-bill","module":"doudian-bill","agent":"shop_demo","label":"结算账单",
//     "enabled":true,"site":"doudian","maxPages":3 }

import { openProfile } from "./_browser.mjs";

const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);
const num = (s) => {
  const m = String(s == null ? "" : s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export default {
  id: "doudian-bill",
  agent: "shop_demo",
  async run(cfg) {
    const site = cfg.site || "doudian";

    let ctx;
    try {
      ctx = await openProfile(site, { viewport: { width: 1680, height: 1050 } });
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 160) };
    }

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://fxg.jinritemai.com/ffa/fxg-bill/fund-detail-bill", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(6000);

      if (/login|passport|sso/i.test(page.url())) {
        return { ok: false, error: "被踢回登录页：会话过期，重扫一次" };
      }

      // 点「结算账单」
      const okTab = await page.evaluate(() => {
        const el = [...document.querySelectorAll("div,span,li,a,button")].find((e) => (e.innerText || "").trim() === "结算账单");
        if (!el) return false;
        el.click();
        return true;
      });
      if (!okTab) return { ok: false, error: "账单明细页没有「结算账单」页签（改版了？）" };
      await page.waitForTimeout(6500);

      const scrapeOnce = async () => page.evaluate(() => {
        const t = [...document.querySelectorAll("table")].find((x) => /平台服务费/.test(x.innerText || ""));
        if (!t) return [];
        return [...t.querySelectorAll("tbody tr")].map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").replace(/\s+/g, " ").trim())
        );
      });

      const clickPage = async (n) => {
        const ok = await page.evaluate((num) => {
          const cands = [...document.querySelectorAll("li,div,span,button,a")]
            .filter((e) => (e.innerText || "").trim() === String(num) && e.offsetParent !== null);
          const pick = cands.find((e) =>
            /pagination|pager/i.test(String(e.parentElement?.className || "") + String(e.className || ""))
          ) || cands[0];
          if (!pick) return false;
          pick.click();
          return true;
        }, n).catch(() => false);
        if (!ok) {
          const nxt = await page.evaluate(() => {
            const el = [...document.querySelectorAll("[class*=next],[title*=下一页],button")]
              .find((e) => /next|下一页/i.test(String(e.className || "") + (e.title || "")) && e.offsetParent !== null);
            if (!el) return false;
            el.click();
            return true;
          }).catch(() => false);
          if (!nxt) return false;
        }
        await page.waitForTimeout(3500);
        return true;
      };

      const maxPages = Math.max(1, Number(cfg.maxPages || 25));
      const seenIds = new Set();
      let rows = [];
      for (let p = 1; p <= maxPages; p++) {
        if (p > 1) {
          const okGo = await clickPage(p);
          if (!okGo) break;
        }
        const batch = await scrapeOnce();
        let added = 0;
        for (const r of batch) {
          if (r[0] === "结算时间" || !/^\d{4}-\d{2}-\d{2}/.test(String(r[0] || ""))) continue;
          const oid = (String(r[2] || "").match(/\d{15,20}/) || [])[0];
          if (!oid || seenIds.has(oid)) continue;
          seenIds.add(oid);
          rows.push(r);
          added++;
        }
        if (added === 0) break;
      }

      if (!rows.length) return { ok: false, error: "结算账单表里没有数据行（还没结算过？）" };

      const out = [];
      for (const r of rows) {
        // 表头那行会重复出现，跳过
        if (r[0] === "结算时间" || !/^\d{4}-\d{2}-\d{2}/.test(String(r[0] || ""))) continue;

        const note = String(r[r.length - 1] || "");
        const orderId = (String(r[2] || "").match(/\d{15,20}/) || [])[0];
        if (!orderId) continue;

        const itemId = (String(r[4] || "").match(/商品ID\s*(\d{15,20})/) || [])[1] || null;
        const feeCell = String(r[12] || "");
        const ratePct = (feeCell.match(/费率\s*([\d.]+)\s*%/) || [])[1] || (note.match(/平台服务费率\s*([\d.]+)\s*%/) || [])[1] || null;
        const category = (note.match(/商品类目[:：]\s*([^;；]+)/) || [])[1] || null;

        out.push({
          order_id: orderId,
          settle_at: String(r[0] || "").slice(0, 19),
          order_at: String(r[1] || "").slice(0, 19),
          item_id: itemId,
          settle_amount: num(r[8]),
          subsidy: num(r[9]),
          paid: num(r[10]),
          base: num(r[11]),
          service_fee: num(feeCell),          // 负数
          talent_fee: num(r[13]),
          fee_rate: ratePct ? Number(ratePct) / 100 : null,
          category,
          note: note.slice(0, 200),
          fetched_at: new Date().toISOString(),
        });
      }

      if (!out.length) return { ok: false, error: "解析出 0 条结算记录（表结构变了？）" };

      // 归纳费率：同一类目取出现次数最多的费率
      const byCat = new Map();
      for (const s of out) {
        if (!s.category || s.fee_rate == null) continue;
        const k = s.category;
        const rec = byCat.get(k) || { category: k, counts: new Map(), samples: 0 };
        rec.samples++;
        rec.counts.set(s.fee_rate, (rec.counts.get(s.fee_rate) || 0) + 1);
        byCat.set(k, rec);
      }
      const feeRates = [...byCat.values()].map((r) => {
        const [rate, n] = [...r.counts.entries()].sort((a, b) => b[1] - a[1])[0];
        return { category: r.category, rate, samples: r.samples, hit: n };
      });

      const main = feeRates.sort((a, b) => b.samples - a.samples)[0];

      return {
        ok: true,
        value: main ? `${(main.rate * 100).toFixed(2)}%` : String(out.length),
        extra: main
          ? `账单实查 ${(main.rate * 100).toFixed(2)}% · ${out.length} 笔结算 · ${localHM()}`
          : `账单 ${out.length} 笔，但没解析到费率`,
        settlements: out,
        feeRates,
        report: main
          ? `结算账单 ${out.length} 笔；类目「${main.category}」费率 ${(main.rate * 100).toFixed(2)}%（${main.samples} 笔）`
          : `结算账单 ${out.length} 笔，费率未解析到`,
        payload: { count: out.length, feeRates },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
