#!/usr/bin/env node
// sync.mjs —— 跑所有启用的连接器，把真实数据写进内核
//
//   node sync.mjs              # 跑 connectors.json 里 enabled 的
//   node sync.mjs npm github   # 只跑指定的
//   node sync.mjs --dry        # 只打印，不写库
//
// 每个连接器跑完做两件事（都走已有接口，不直连数据库）：
//   1. POST /api/agents/:id/heartbeat  -> 主指标 + 下次时间 + 点亮在岗灯
//   2. POST /api/reports               -> 一句话汇报（进 CEO 的汇报流）
// 拿不到数就 **不写**，只记一条「数据源降级」，界面保留上次数值。
// 这是和 8899 的根本区别：那个手写 DATA，这里写不进去就是写不进去。

import fs from "node:fs";
import path from "node:path";
import { postJSON } from "./connectors/_http.mjs";

const ROOT = import.meta.dirname;
const cfgPath = path.join(ROOT, "connectors.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const BASE = process.env.AINATIVE_URL || cfg.base || "http://127.0.0.1:8788";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const only = args.filter((a) => !a.startsWith("--"));

// 按「模块名」找实现（connectors.json 里每条都有 module 字段）。
// 同一个模块可以挂 N 条配置 —— 每家店一份 CSV、每个号一份 JSON，都走这里。
const MODULES = {
  github: () => import("./connectors/github.mjs").then((m) => m.default),
  npm: () => import("./connectors/npm.mjs").then((m) => m.default),
  csv: () => import("./connectors/csv.mjs").then((m) => m.default),
  "http-json": () => import("./connectors/http-json.mjs").then((m) => m.default),
  "douyin-shop": () => import("./connectors/douyin-shop.mjs").then((m) => m.default),
  pdd: () => import("./connectors/pdd.mjs").then((m) => m.default),
  "browser-table": () => import("./connectors/browser-table.mjs").then((m) => m.default),
  "doudian-orders": () => import("./connectors/doudian-orders.mjs").then((m) => m.default),
  "doudian-products": () => import("./connectors/doudian-products.mjs").then((m) => m.default),
  "doudian-skus": () => import("./connectors/doudian-skus.mjs").then((m) => m.default),
  "doudian-bill": () => import("./connectors/doudian-bill.mjs").then((m) => m.default),
  "buyin-hot": () => import("./connectors/buyin-hot.mjs").then((m) => m.default),
  "compass-rank": () => import("./connectors/compass-rank.mjs").then((m) => m.default),
  qianchuan: () => import("./connectors/qianchuan.mjs").then((m) => m.default),
  "browser-session": () => import("./connectors/browser-session.mjs").then((m) => m.default),
  taobao: () => import("./connectors/taobao.mjs").then((m) => m.default),
  "amazon-sp": () => import("./connectors/needs-credentials.mjs").then((m) => m.amazonSP),
  printful: () => import("./connectors/needs-credentials.mjs").then((m) => m.printful),
  douyin: () => import("./connectors/needs-credentials.mjs").then((m) => m.douyin),
};

const resolveModule = (c) => MODULES[c.module || c.id] || null;

const pad = (s, n) => String(s).padEnd(n, " ");
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const list = cfg.connectors.filter((c) => (only.length ? only.includes(c.id) : c.enabled));
  if (!list.length) {
    console.log("没有要跑的连接器。改 connectors.json 里的 enabled，或直接点名：node sync.mjs npm");
    return;
  }

  console.log(`-> ${BASE}  ·  ${list.length} 个连接器${dry ? "  [dry run]" : ""}\n`);

  let okN = 0, failN = 0;
  for (const c of list) {
    const t0 = Date.now();
    let res;
    try {
      const mod = await (resolveModule(c) || (() => null))();
      if (!mod) { res = { ok: false, error: `没有这个连接器：${c.id}` }; }
      else {
        // 时间窗纪律：定时泵（没带 ECOM_TAB）也必须按「这家店当前选的窗口」抓，
        // 否则每 5 分钟就会用实时数据覆盖掉用户选的近7天/近30天，口径就乱了。
        if (!process.env.ECOM_TAB && (c.module === "browser-session")) {
          try {
            const shops = JSON.parse(fs.readFileSync(new URL("./shops.json", import.meta.url), "utf8"));
            const mine = shops.find((s) => s.agent === (c.agent || ""));
            if (mine?.window && mine.window !== "实时") process.env.ECOM_TAB = mine.window;
          } catch {}
        }
        res = await mod.run(c);
      }
    } catch (e) {
      res = { ok: false, error: String(e.message || e) };
    }
    const ms = Date.now() - t0;
    const agent = c.agent || "ceo";

    if (!res.ok) {
      failN++;
      console.log(`[X] ${pad(c.id, 12)} ${pad(c.label || "", 10)} ${ms}ms  ${res.error}`);
      if (!dry) {
        // 注意顺序：/api/reports 会把在岗灯点亮，所以必须先写汇报、最后才熄灯。
        await postJSON(`${BASE}/api/reports`, {
          agent_id: agent,
          summary: `[数据源降级] ${c.id}：${res.error}。本班用上次数值，没有造假数。`,
        });
        await postJSON(`${BASE}/api/agents/${agent}/heartbeat`, {
          alive: false,
          metric_extra: `上一班失败：${String(res.error).slice(0, 40)}`,
        });
        await postJSON(`${BASE}/api/agents/${agent}/submetric`, {
          key: c.id, label: c.label || c.id, value: null,
          extra: String(res.error).slice(0, 40), ok: false,
        });
      }
      continue;
    }

    okN++;
    console.log(`[OK] ${pad(c.id, 12)} ${pad(c.label || "", 10)} ${ms}ms  ${res.value}  ${res.extra || ""}`);
    if (dry) continue;

    const isMain = c.main !== false;   // 没写 main 的按主指标算

    const hb = isMain
      ? await postJSON(`${BASE}/api/agents/${agent}/heartbeat`, {
          metric_label: c.label,
          metric_value: String(res.value),
          metric_extra: res.extra || null,
          next_run_at: new Date(Date.now() + (c.every_min || 60) * 60000).toISOString(),
        })
      : { ok: true };

    const rp = isMain
      ? await postJSON(`${BASE}/api/reports`, {
          agent_id: agent,
          summary: res.report || `${c.id} 取到 ${res.value}`,
          payload: res.payload || null,
        })
      : { ok: true };

    // 子指标：一个 Agent 接多个源时，各自一行，不互相覆盖
    const sm = await postJSON(`${BASE}/api/agents/${agent}/submetric`, {
      key: c.id,
      label: c.label || c.id,
      value: res.value,
      extra: res.extra || null,
      ok: true,
    });

    // 一次开页面抓到多个数（res.subs）：每个都写一行子指标
    let subsOk = true;
    if (Array.isArray(res.subs)) {
      for (const s of res.subs) {
        const r2 = await postJSON(`${BASE}/api/agents/${agent}/submetric`, {
          key: s.key, label: s.label,
          value: s.value == null ? null : String(s.value),
          extra: s.ok ? (res.extra || null) : "没抓到",
          ok: !!s.ok,
        });
        if (!r2.ok) subsOk = false;
      }
    }

    // 多窗口快照：把这次抓到的数按「当前时间窗」单独存一份，不覆盖别的窗口
    if (Array.isArray(res.subs) && res.subs.length) {
      const winLabel = process.env.ECOM_TAB || "实时";
      const sn = await postJSON(`${BASE}/api/agents/${agent}/snapshot`, {
        win: winLabel,
        metrics: res.subs.map((s) => ({ key: s.key, label: s.label, value: s.value, extra: res.extra || null, ok: s.ok })),
      });
      if (sn.ok) console.log(`   -> 快照已存（${winLabel} · ${sn.body?.written ?? 0} 项）`);
    }

    // 千川：计划快照 + 账户总览
    if (res.payload && Array.isArray(res.payload.rows)) {
      const tb = await postJSON(`${BASE}/api/tc/bulk`, { snapshot: res.payload, rows: res.payload.rows });
      if (tb.ok) console.log(`   -> 千川计划写入 ${tb.body?.written ?? 0} 个，账户快照已存`);
      else console.log(`   -> 千川写库失败：${tb.body?.error || tb.error}`);
    }

    // 千川素材库
    if (res.payload && Array.isArray(res.payload.materials)) {
      const mb = await postJSON(`${BASE}/api/tc/materials/bulk`, { materials: res.payload.materials });
      if (mb.ok) console.log(`   -> 素材写入 ${mb.body?.written ?? 0} 条`);
      else console.log(`   -> 素材写库失败：${mb.body?.error || mb.error}`);
    }

    // 抓到的是一张表（订单明细）：逐行入库
    if (Array.isArray(res.rows) && res.rows.length) {
      const ob = await postJSON(`${BASE}/api/orders/bulk`, { shop: agent, rows: res.rows });
      console.log(`   ↳ 订单明细写入 ${ob.body?.written ?? 0} 行`);
      const lk = await postJSON(`${BASE}/api/orders/link?shop=${encodeURIComponent(agent)}`, {});
      if (lk.ok) console.log(`   ↳ 商品ID 匹配：${lk.body?.linked ?? 0}/${lk.body?.total ?? 0} 单（未匹配 ${lk.body?.missed ?? 0}）`);
    }

    // 抓到的是一批商品（商品ID + 标题 + 价格 + 库存）
    if (Array.isArray(res.products) && res.products.length) {
      const pb = await postJSON(`${BASE}/api/products/bulk`, { shop: agent, products: res.products });
      console.log(`   ↳ 商品清单写入 ${pb.body?.written ?? 0} 个`);
      const lk = await postJSON(`${BASE}/api/orders/link?shop=${encodeURIComponent(agent)}`, {});
      if (lk.ok) console.log(`   ↳ 商品ID 匹配：${lk.body?.linked ?? 0}/${lk.body?.total ?? 0} 单`);
    }

    // 市场采集（精选联盟 / 罗盘）
    if (Array.isArray(res.market) && res.market.length) {
      const mb = await postJSON(`${BASE}/api/market/bulk`, { items: res.market });
      console.log(`   -> 市场数据写入 ${mb.body?.written ?? 0} 条`);
    }

    // 结算账单：费率、补贴、服务费逐笔入库，并归纳类目费率
    if (Array.isArray(res.settlements) && res.settlements.length) {
      const sb = await postJSON(`${BASE}/api/settlements/bulk`, {
        shop: agent,
        settlements: res.settlements,
        feeRates: res.feeRates || [],
      });
      console.log(`   -> 结算账单写入 ${sb.body?.written ?? 0} 笔，类目费率 ${sb.body?.rates ?? 0} 条`);
    }

    // 抓到的是一批 SKU（规格 / 售价 / 库存 / SKUID）
    if (Array.isArray(res.skus) && res.skus.length) {
      const sb = await postJSON(`${BASE}/api/skus/bulk`, { shop: agent, skus: res.skus });
      console.log(`   ↳ SKU 写入 ${sb.body?.written ?? 0} 条`);
    }
    if (!hb.ok || !rp.ok || !sm.ok) console.log(`   ↳ 写库失败：${hb.error || ""} ${rp.error || ""} ${sm.error || ""}`);
  }

  console.log(`\n完成：${okN} 成功 / ${failN} 失败  ·  ${now()}`);
  if (failN) console.log("失败的没有伪造数据，界面保留上一班的值并标红。");
}

main().catch((e) => { console.error("sync 崩了：", e); process.exit(1); });
