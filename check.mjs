#!/usr/bin/env node
/* check.mjs —— 一键体检：每步做完跑一下，看哪些到位、哪些还差
 *
 *   node check.mjs
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { exec } from "node:child_process";

const ROOT = import.meta.dirname;
const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";
const ok = (b) => (b ? "[ OK ]" : "[FAIL]");
const warn = (b) => (b ? "[ OK ]" : "[WARN]");

const portUp = () => new Promise((resolve) => {
  const s = new net.Socket();
  s.setTimeout(1200);
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("timeout", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(false));
  s.connect(8788, "127.0.0.1");
});

const get = async (p) => {
  try {
    const r = await fetch(`${BASE}${p}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
};

const psCmds = () => new Promise((resolve) => {
  exec(`powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { $_.CommandLine }"`,
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out) => resolve(e ? "" : String(out || "")));
});

console.log(`\n==== 体检 · ${new Date().toLocaleString("zh-CN", { hour12: false })} ====\n`);

// 1. 服务
const up = await portUp();
console.log(`1. 服务 8788        ${ok(up)} ${up ? "在跑" : "没起（node keepalive.mjs）"}`);

// 2. 守护
const cmds = await psCmds();
const lines = cmds.split(/\r?\n/).filter((l) => l && !l.includes("runner.js"));
const hasDog = lines.some((l) => l.includes("keepalive.mjs"));
const hasMetrics = lines.some((l) => l.includes("watch.mjs") && l.includes("shop_demo-browser"));
const hasData = lines.some((l) => l.includes("watch.mjs") && l.includes("doudian-orders"));
const hasMarket = lines.some((l) => l.includes("watch.mjs") && l.includes("compass-"));
console.log(`2. 看门狗           ${ok(hasDog)}  指标泵 ${ok(hasMetrics)}  数据泵 ${ok(hasData)}  市场泵 ${ok(hasMarket)}`);

if (!up) { console.log("\n服务没起，后面查不了。先 node keepalive.mjs --once\n"); process.exit(1); }

// 3. 店铺与数据
const shops = (await get("/api/shops"))?.shops || [];
const s = shops[0];
if (!s) { console.log("3. 店铺             [FAIL] 没有店铺"); process.exit(1); }
const age = s.last_run_at ? Math.round((Date.now() - Date.parse(s.last_run_at)) / 60000) : null;
console.log(`3. 店铺             [ OK ] ${s.platform_name} · ${s.name}（窗口 ${s.window_label}）`);
console.log(`   连接 ${ok(s.alive)} · 订单 ${s.order_count} · 商品 ${s.product_count} · 数据 ${age === null ? "没跑过" : age + " 分钟前"}`);

// 4. 经营参数（毛利地基）
const cfg = (await get(`/api/ecom/config?shop=${s.agent}`))?.config;
const costed = Object.values(cfg?.items || {}).filter((v) => Number(v) > 0).length;
const feeReady = Number(cfg?.categoryFeeRate) > 0;
console.log(`4. 经营参数         ${ok(s.params_ready)}  成本已填 ${costed}/${s.product_count} · 扣点 ${feeReady ? (cfg.categoryFeeRate * 100).toFixed(2) + "%" : "未填"}`);

// 5. 授权政策
let P = null;
try { P = JSON.parse(fs.readFileSync(path.join(ROOT, "policies.json"), "utf8")); } catch {}
if (P) {
  const auto = Object.entries(P.auto_exec || {}).filter(([, v]) => v.allow).map(([k]) => k.replace("douyin.", ""));
  console.log(`5. 授权政策         [ OK ] 可自动：${auto.join(" / ")}`);
  console.log(`   金额红线 ¥${P.max_single_cny} · 保护款 ${(P.protect_product_ids || []).length} 个`);
} else {
  console.log(`5. 授权政策         [FAIL] 没有 policies.json（全部动作都要你批）`);
}

// 6. 平台凭证
const c = (await get("/api/connectors"))?.connectors?.find((x) => x.module === "douyin-shop" || x.id === "douyin-shop");
const envs = ["DOUYIN_SHOP_APP_KEY", "DOUYIN_SHOP_APP_SECRET", "DOUYIN_SHOP_ACCESS_TOKEN"];
const ready = envs.every((e) => !!process.env[e]);
console.log(`6. 平台凭证         ${ok(ready)} ${ready ? "已配" : "缺 " + envs.filter((e) => !process.env[e]).join(" / ")}`);
if (!ready) console.log(`   -> 没有它：改主图/下架/发货只能 dry-run 看请求，发不出去`);

// 7. 台账与决策
const st = await get("/api/state");
const openCards = (st?.cards || []).filter((x) => !["done", "cancelled"].includes(x.status)).length;
const mine = (st?.cards || []).filter((x) => x.owner === "S" && !["done", "cancelled"].includes(x.status)).length;
const pend = (st?.decisions || []).filter((d) => d.answer == null).length;
const kb = (await get("/api/kb?limit=1"))?.count ?? 0;
console.log(`7. 台账             [ OK ] 未结 ${openCards} 张（派给你 ${mine} 张）· 等你拍板 ${pend} 件 · 知识库 ${kb} 条`);

// 8. 自动循环
const autoLog = path.join(ROOT, "logs", "auto.log");
let lastAuto = null;
try {
  const t = fs.statSync(autoLog).mtimeMs;
  lastAuto = Math.round((Date.now() - t) / 60000);
} catch {}
console.log(`8. 自动循环         ${warn(lastAuto !== null && lastAuto < 180)} ${lastAuto === null ? "还没跑过（node auto.mjs --no-sync）" : lastAuto + " 分钟前跑过"}`);

// 9. 选品（市场数据 + 候选）
const mk = await get("/api/market");
const pipe = await get("/api/pipeline");
const mktItems = mk?.items || [];
const mktAge = mktItems.length ? Math.round((Date.now() - Date.parse(mktItems[0].fetched_at)) / 3600000) : null;
const cands = (pipe?.items || []).filter((x) => x.stage === "owner_confirm").length;
const opps = (pipe?.items || []).filter((x) => String(x.name).includes("市场机会")).length;
console.log(`9. 选品             ${warn(!!mktItems.length && mktAge !== null && mktAge < 24)} 市场样本 ${mktItems.length} 条（${mktAge === null ? "没抓" : mktAge + " 小时前"}）· 市场机会 ${opps} 条 · 等你确认 ${cands} 条`);

// 10. 千川投流
const tc = await get("/api/tc");
const tcAds = tc?.ads || [];
const tcMat = tc?.materials || [];
const tcSnap = tc?.snapshot || null;
const tcOpen = (tc?.advice || []).filter((a) => a.status === "open").length;
const tcAge = tcSnap?.at ? Math.round((Date.now() - Date.parse(tcSnap.at)) / 60000) : null;
console.log(`10. 千川投流        ${warn(!!tcAds.length && tcAge !== null && tcAge < 180)} 计划 ${tcAds.length} 个 · 余额 ${tcSnap?.balance == null ? "—" : "¥" + tcSnap.balance} · 今日消耗 ${tcSnap?.cost_today == null ? "—" : "¥" + Number(tcSnap.cost_today).toFixed(2)} · 素材 ${tcMat.length} 条 · 待处理建议 ${tcOpen}`);

console.log(`\n下一步该做什么：`);
if (!s.params_ready) console.log(`  -> 填经营参数：界面「店铺 -> 参数」，8 个商品拿货价 + 类目扣点`);
if (!ready) console.log(`  -> 申请抖店开放平台凭证，写进三个环境变量（详见 写操作接入.md）`);
if (lastAuto === null) console.log(`  -> 跑一轮完整链路：node auto.mjs --no-sync`);
if (s.params_ready && ready && lastAuto !== null) console.log(`  -> 都齐了。看台账和决策页，等它自己干活。`);
console.log();
