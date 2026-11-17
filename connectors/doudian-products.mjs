// 抖店商品管理页 → 商品ID / 标题 / 价格区间 / 库存 / 状态
//
// 页面不是普通 table，行选择器是 tr.ecom-g-table-row，一行长这样：
//   榆林镇风味筋饼…速食  ID：0000000000000000000  现货模式 预览 复制链接
//   ￥8.80 ~ ￥24.80   19794   部分SKU售罄   0   暂无评价 … 售卖中 编辑 下架
//
// 拿这个是为了「按商品链接记拿货成本」——每个链接成本不同，不能按名字模糊匹配。
//
// connectors.json：
//   { "id":"doudian-products","module":"doudian-products","agent":"shop_demo",
//     "label":"商品清单","enabled":true,"site":"doudian",
//     "url":"https://fxg.jinritemai.com/ffa/g/list","maxRows":200 }

import path from "node:path";
import { createRequire } from "node:module";
import { openProfile } from "./_browser.mjs";

const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_DIR, "playwright", "playwright"].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  throw new Error("找不到 playwright，设置 PLAYWRIGHT_DIR");
}

export default {
  id: "doudian-products",
  agent: "shop_demo",
  async run(cfg) {
    const site = cfg.site || "doudian";
    const url = cfg.url || "https://fxg.jinritemai.com/ffa/g/list";
    const profile = path.join(import.meta.dirname, "..", ".browser", site);

    let chromium;
    try { ({ chromium } = loadPlaywright()); } catch (e) { return { ok: false, error: e.message }; }

    const ctx = await openProfile(site).catch((e) => { globalThis.__openErr = e.message; return null; });
    if (!ctx) return { ok: false, error: globalThis.__openErr || `打不开 profile（先扫码登录 site=${site}）` };

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

      const okWait = await page.waitForFunction(
        () => /ID[:：]\s*\d{15,20}/.test(document.body?.innerText || ""),
        null, { timeout: Number(cfg.wait || 25000) }
      ).then(() => true).catch(() => false);

      if (!okWait) {
        const cur = page.url();
        if (/login|passport|sso/i.test(cur)) return { ok: false, error: "被踢回登录页：会话过期，重扫一次" };
        return { ok: false, error: "等不到商品ID：页面没渲染 / 没有商品 / 改版" };
      }
      await page.waitForTimeout(2000);

      const rows = await page.evaluate((maxRows) => {
        const trs = [...document.querySelectorAll("tr.ecom-g-table-row, tr.style_rowColumn__joVnW")];
        const out = [];
        for (const tr of trs) {
          const t = (tr.innerText || "").replace(/\s+/g, " ").trim();
          const idm = t.match(/ID[:：]\s*(\d{15,20})/);
          if (!idm) continue;
          const itemId = idm[1];
          const title = t.slice(0, t.indexOf("ID")).trim().slice(0, 200);
          // 价格：￥8.80 ~ ￥24.80 或单个 ￥8.80
          const range = t.match(/￥\s*([\d.]+)\s*[~～-]\s*￥?\s*([\d.]+)/);
          const single = t.match(/￥\s*([\d.]+)/);
          const priceMin = range ? Number(range[1]) : single ? Number(single[1]) : null;
          const priceMax = range ? Number(range[2]) : priceMin;
          // 库存：价格后面那个整数
          const afterPrice = t.slice(t.search(/￥\s*[\d.]+/));
          const stockM = afterPrice.match(/^\S*\s+(\d{1,9})\b/);
          const stock = stockM ? Number(stockM[1]) : null;
          const status = (t.match(/售卖中|已下架|已售罄|已封禁|审核中|审核驳回|草稿/) || [null])[0];
          out.push({ item_id: itemId, title, price_min: priceMin, price_max: priceMax, stock, status, raw: t.slice(0, 400) });
          if (out.length >= maxRows) break;
        }
        return out;
      }, Number(cfg.maxRows || 200));

      if (!rows.length) return { ok: false, error: "解析出 0 个商品（行选择器可能变了）" };

      const fetchedAt = new Date().toISOString();
      return {
        ok: true,
        value: String(rows.length),
        extra: `${site} 商品 ${rows.length} 个 · ${localHM()}`,
        products: rows.map((r) => ({ ...r, fetched_at: fetchedAt })),
        report: `${site}：商品清单 ${rows.length} 个（含商品ID，用于按链接记成本）。`,
        payload: { url, count: rows.length },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
