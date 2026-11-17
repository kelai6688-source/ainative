// 抖店商品 SKU 清单：规格 / 售价 / 库存 / SKUID
//
// 为什么必须抓 SKU 而不是只抓商品：
//   同一个商品下面有多个规格（尝鲜装 8.8 / 家庭装 14.8 / 囤货装 24.8），
//   拿货成本按规格差得很远，一个商品一个输入框根本写不清。
//
// 页面：/ffa/g/create?product_id=<ID>（商品编辑页，只读取不保存）
// 每行的结构（实测）：
//   【囤货装】100张180g*10袋 | ￥24.8/10袋 | ￥24.8/1.8kg | 9957 增 减 | 9957 清空 | - 3393462772153125 | 已上架
//
// connectors.json：
//   { "id":"doudian-skus","module":"doudian-skus","agent":"shop_demo","label":"SKU清单",
//     "enabled":true,"site":"doudian","maxProducts":20 }

import { openProfile } from "./_browser.mjs";

const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);

export default {
  id: "doudian-skus",
  agent: "shop_demo",
  async run(cfg) {
    const site = cfg.site || "doudian";

    let ctx;
    try {
      ctx = await openProfile(site, { viewport: { width: 1600, height: 1100 } });
    } catch (e) {
      return { ok: false, error: String(e.message || e).slice(0, 160) };
    }

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());

      // 先去商品列表拿商品ID（也顺便确认登录态）
      await page.goto("https://fxg.jinritemai.com/ffa/g/list", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      const listOk = await page.waitForFunction(
        () => /ID[:：]\s*\d{15,20}/.test(document.body?.innerText || ""), null, { timeout: 25000 }
      ).then(() => true).catch(() => false);
      if (!listOk) {
        const cur = page.url();
        if (/login|passport|sso/i.test(cur)) return { ok: false, error: "被踢回登录页：会话过期，重扫一次" };
        return { ok: false, error: "商品列表没加载出来（改版 / 网络慢）" };
      }

      const products = await page.evaluate((max) => {
        const out = [];
        for (const tr of document.querySelectorAll("tr.ecom-g-table-row")) {
          const t = (tr.innerText || "").replace(/\s+/g, " ");
          const m = t.match(/ID[:：]\s*(\d{15,20})/);
          if (!m) continue;
          out.push({ item_id: m[1], title: t.slice(0, t.indexOf("ID")).trim().slice(0, 120) });
          if (out.length >= max) break;
        }
        return out;
      }, Number(cfg.maxProducts || 20));

      if (!products.length) return { ok: false, error: "商品列表里没解析出商品ID" };

      const all = [];
      for (const p of products) {
        await page.goto(`https://fxg.jinritemai.com/ffa/g/create?product_id=${p.item_id}`,
          { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        const ok = await page.waitForFunction(
          () => /SKUID/.test(document.body?.innerText || ""), null, { timeout: 20000 }
        ).then(() => true).catch(() => false);
        if (!ok) continue;

        // 滚到 SKU 表，让它渲染出来
        await page.evaluate(() => {
          const el = [...document.querySelectorAll("*")].find((e) => (e.innerText || "").trim() === "SKUID");
          if (el) el.scrollIntoView({ block: "center" });
        }).catch(() => {});
        await page.waitForTimeout(2200);

        const rows = await page.evaluate(() => {
          const parse = (t) => {
            const spec = (t.match(/【[^】]+】[^\s￥|]*/) || [])[0];
            const price = (t.match(/￥\s*([\d.]+)/) || [])[1];
            const skuId = (t.match(/-\s*(\d{13,20})/) || [])[1];
            const stocks = t.match(/(\d{1,9})\s*增\s*减\s*(\d{1,9})/);
            const status = (t.match(/已上架|已下架|已售罄|审核中/) || [null])[0];
            if (!spec || !price) return null;
            return { spec: spec.trim(), price: Number(price), stock: stocks ? Number(stocks[2]) : null, sku_id: skuId || null, status };
          };

          // 策略一：找「含 SKUID、且有多个输入框」的容器（实测这个最准）
          let host = [...document.querySelectorAll("div,section")]
            .filter((e) => /SKUID/.test(e.innerText || "") && e.querySelectorAll("input").length >= 2)
            .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];

          let out = [];
          if (host) {
            for (const el of host.querySelectorAll("tr,div[class*=row],div[class*=Row]")) {
              const t = (el.innerText || "").replace(/\s+/g, " ").trim();
              if (t.length > 260 || !/【/.test(t) || !/￥/.test(t)) continue;
              const r = parse(t);
              if (r) out.push(r);
            }
          }

          // 策略二（兜底）：全页扫「含【规格】且有￥」的最小节点
          if (!out.length) {
            for (const el of document.querySelectorAll("div,span,td,li")) {
              const t = (el.innerText || "").replace(/\s+/g, " ").trim();
              if (t.length > 200 || !/【/.test(t) || !/￥/.test(t)) continue;
              if (el.children.length > 6) continue;
              const r = parse(t);
              if (r) out.push(r);
            }
          }

          const seen = new Set();
          return out.filter((r) => (seen.has(r.spec) ? false : (seen.add(r.spec), true)));
        });

        for (const r of rows) all.push({ ...r, item_id: p.item_id, title: p.title });
        if (all.length >= 400) break;
      }

      if (!all.length) return { ok: false, error: "一个 SKU 都没解析出来（页面结构可能变了）" };

      const fetchedAt = new Date().toISOString();
      return {
        ok: true,
        value: String(all.length),
        extra: `${site} SKU ${all.length} 个 · ${localHM()}`,
        skus: all.map((s) => ({ ...s, fetched_at: fetchedAt })),
        report: `${site}：抓到 ${all.length} 个 SKU（${products.length} 个商品），含规格/售价/库存/SKUID。`,
        payload: { count: all.length, products: products.length },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
