// 抖店订单列表 → 逐单入库
//
// 抖店订单页的结构不是普通表格：**一个订单占两行**
//   第 1 行：[空] | 订单编号 6919... 下单时间 2026-11-16 08:48:32  ...
//   第 2 行：[空] | 商品名 商品单ID:6919... | ¥24.80 x1 | 售后 | 已发货 | ¥19.80 | 收货 | 操作
// 所以要把两行配对，按订单编号归并。
//
// 只读页面，不点任何按钮、不改任何状态。
//
// connectors.json：
//   {
//     "id": "doudian-orders", "module": "doudian-orders", "agent": "shop_demo",
//     "label": "订单明细", "enabled": true, "site": "doudian",
//     "url": "https://fxg.jinritemai.com/ffa/morder/order/list",
//     "maxOrders": 100
//   }

import path from "node:path";
import { createRequire } from "node:module";
import { openProfile } from "./_browser.mjs";

const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);

// 增量拉取的锚点：库里最新一单的下单时间。
// 定时泵每 10 分钟跑一次，如果每次都把 50 页翻完，光翻页就要 3 分钟以上，
// 看门狗 120 秒就把它掐了 —— 表现就是「拉取失败：Command failed」。所以：
//   从第 1 页往下翻，翻到「整页都比库里的最新时间还旧」就停。
// 想强制全量：ORDERS_FULL=1 node sync.mjs doudian-orders
const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";

async function newestStored(shop) {
  try {
    const r = await fetch(`${BASE}/api/orders?shop=${encodeURIComponent(shop)}&limit=1`);
    if (!r.ok) return null;
    const j = await r.json();
    return j?.rows?.[0]?.created_at || null;
  } catch { return null; }
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_DIR, "playwright", "playwright"].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  throw new Error("找不到 playwright，设置 PLAYWRIGHT_DIR");
}

export default {
  id: "doudian-orders",
  agent: "dyshop",
  async run(cfg) {
    const site = cfg.site || "doudian";
    const profile = path.join(import.meta.dirname, "..", ".browser", site);
    const url = cfg.url || "https://fxg.jinritemai.com/ffa/morder/order/list";

    let chromium;
    try { ({ chromium } = loadPlaywright()); } catch (e) { return { ok: false, error: e.message }; }

    const ctx = await openProfile(site).catch((e) => { globalThis.__openErr = e.message; return null; });
    if (!ctx) return { ok: false, error: globalThis.__openErr || `打不开 profile（先扫码登录 site=${site}）` };

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

      const okWait = await page
        .waitForFunction(() => /订单编号/.test(document.body?.innerText || ""), null, { timeout: Number(cfg.wait || 15000) })
        .then(() => true).catch(() => false);
      if (!okWait) {
        const cur = page.url();
        if (/login|passport|sso/i.test(cur)) return { ok: false, error: "被踢回登录页：会话过期，重扫一次" };
        return { ok: false, error: "等不到「订单编号」：页面没渲染完 / 没有订单 / 改版" };
      }
      await page.waitForTimeout(2500);

      // ── 翻页 ────────────────────────────────────────────
      // 订单列表默认 10 条/页，只抓第一页会漏掉绝大多数订单，
      // 一旦拿它去跟后台的月度汇总混算，毛利会算成负数。
      // 策略：把每页改成 100 条，然后顺着页码翻，直到没有新订单或到 maxPages。
      const setPageSize = async (size) => {
        const okSize = await page.evaluate((want) => {
          const sel = [...document.querySelectorAll("div,span")].find((e) => /^\d+\s*条\/页$/.test((e.innerText || "").trim()));
          if (!sel) return false;
          sel.click();
          return true;
        }, size).catch(() => false);
        if (!okSize) return false;
        await page.waitForTimeout(900);
        const picked = await page.evaluate((want) => {
          const opt = [...document.querySelectorAll("[class*=option],[class*=Option],li")]
            .find((e) => (e.innerText || "").trim() === want + " 条/页" || (e.innerText || "").trim() === want + "条/页");
          if (!opt) return false;
          opt.click();
          return true;
        }, size).catch(() => false);
        if (!picked) return false;
        await page.waitForTimeout(2500);
        return true;
      };

      // 抖店订单页每页固定 10 条（下拉只有 10 条/页），URL 加 pageSize 无效。
      // 实测可靠的方式：点分页里的页码数字。713 单 = 72 页，翻 50 页约 3 分钟。
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
              .find((e) => /next|下一页/i.test(String(e.className || "") + (e.title || "") + (e.getAttribute("aria-label") || "")) && e.offsetParent !== null);
            if (!el) return false;
            el.click();
            return true;
          }).catch(() => false);
          if (!nxt) return false;
        }
        await page.waitForTimeout(3500);
        return true;
      };

      const scrapeOnce = async () => page.evaluate((maxOrders) => {
        const trs = [...document.querySelectorAll(".aurora-table-row")].filter((r) => !r.className.includes("measure"));
        const orders = [];
        let cur = null;

        const pick = (t, re) => { const m = String(t).match(re); return m ? m[1] : null; };

        for (const tr of trs) {
          const tds = [...tr.querySelectorAll("td")];
          const all = (tr.innerText || "").replace(/\s+/g, " ").trim();

          // 第 1 行：订单编号 + 下单时间
          if (/订单编号/.test(all)) {
            if (cur) orders.push(cur);
            cur = {
              order_id: pick(all, /订单编号\s*(\d{6,})/),
              created_at: pick(all, /下单时间\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/),
              sku: null, qty: null, amount: null, status: null, item_id: null,
            };
            continue;
          }
          if (!cur) continue;

          // 第 2 行：商品 / 金额 / 状态
          const goods = (tds[1]?.innerText || "").replace(/\s+/g, " ").trim();
          if (goods && !cur.sku) {
            cur.sku = goods.split("商品单ID")[0].trim().slice(0, 120) || goods.slice(0, 120);
            cur.item_id = pick(goods, /商品单ID[:：]\s*(\d+)/);
          }
          const pq = (tds[2]?.innerText || "").replace(/\s+/g, " ");
          const pm = pq.match(/¥\s*([\d.]+)\s*[x×]\s*(\d+)/i);
          if (pm) { cur.amount = Number(pm[1]) * Number(pm[2]); cur.qty = Number(pm[2]); }

          const statusTxt = (tds[4]?.innerText || "").trim();
          if (statusTxt) {
            const known = ["待付款", "待发货", "已发货", "已完成", "已取消", "退款中", "已退款", "待收货", "交易关闭"];
            const hit = known.find((k) => statusTxt.includes(k));
            cur.status = hit || statusTxt.split(/\s/)[0];
          }
          const income = (tds[5]?.innerText || "").match(/¥\s*([\d.]+)/);
          if (income) cur.income = Number(income[1]);
          if (orders.length >= maxOrders) break;
        }
        if (cur) orders.push(cur);

        return orders.filter((o) => o.order_id).slice(0, maxOrders);
      }, 5000);

      const maxPages = Math.max(1, Number(cfg.maxPages || 8));
      const shopKey = cfg.agent || "doudian";
      const since = process.env.ORDERS_FULL === "1" ? null : await newestStored(shopKey);
      if (since) console.log("   增量锚点：" + since + "（比这更旧的一页就停）");


      const seen = new Set();
      const rows = [];
      for (let p = 1; p <= maxPages; p++) {
        if (p > 1) {
          const okGo = await clickPage(p);
          if (!okGo) { console.log("   （翻到第 " + p + " 页失败，停）"); break; }
        }
        const batch = await scrapeOnce();
        let added = 0;
        for (const o of batch) {
          if (!o || !o.order_id || seen.has(o.order_id)) continue;
          seen.add(o.order_id);
          rows.push(o);
          added++;
        }
        console.log("   第 " + p + " 页：+" + added + "（累计 " + rows.length + "）");
        if (added === 0) break;

        // 增量停：这一页有下单时间，且全都 ≤ 库里最新一单 → 后面只会更旧
        const dated = batch.filter((o) => o && o.created_at);
        if (since && dated.length && dated.every((o) => String(o.created_at) <= String(since))) {
          console.log("   到增量锚点为止，停在第 " + p + " 页");
          break;
        }
      }

      if (!rows.length) return { ok: false, error: "页面上没解析出订单（结构可能改了）" };

      const fetchedAt = new Date().toISOString();
      const byStatus = rows.reduce((m, r) => ((m[r.status || "未知"] = (m[r.status || "未知"] || 0) + 1), m), {});
      return {
        ok: true,
        value: String(rows.length),
        extra: `${site} 订单 ${rows.length} 单 · ${localHM()}`,
        rows: rows.map((r) => ({ ...r, fetched_at: fetchedAt })),
        report: `${site}：抓到 ${rows.length} 单（` + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") + `）。`,
        payload: { url, count: rows.length, byStatus },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
