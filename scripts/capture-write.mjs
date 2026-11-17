#!/usr/bin/env node
/* capture-write.mjs -- 抓一次真实写操作，换回「自动改预算/调价/关停」的能力
 *
 *   node scripts/capture-write.mjs [分钟数]
 *
 * 做什么：
 *   1. 打开有头浏览器，进千川「全域投放」计划页（用 .browser/doudian 登录态）
 *   2. 页面右上角挂提示条，告诉你该干什么
 *   3. 监听所有写请求（POST/PUT/PATCH/DELETE 到 /ad/api/），写进 logs/write-capture.json
 *
 * 你只需要做一次（挑消耗最小、或已经空跑的计划）：
 *   - 改日预算：1000 -> 1001，保存（之后可用同一套接口改回来）
 *   - 或者 暂停计划 -> 再启用
 */

import fs from "node:fs";
import path from "node:path";
import { openProfile } from "../connectors/_browser.mjs";

const MIN = Math.max(1, Number(process.argv[2] || 10));
const OUT = path.join(import.meta.dirname, "..", "logs", "write-capture.json");
const hits = [];

const ctx = await openProfile("doudian", { headless: false }).catch((e) => { console.error("open profile fail:", e.message); process.exit(1); });
const page = ctx.pages()[0] || (await ctx.newPage());

const isRead = (u) => /statQuery|get-|list-|query|check-|UserConfAndDataSet|getUserConf|manifest/i.test(u);

page.on("request", (r) => {
  const u = r.url();
  if (!/\/ad\/api\//.test(u)) return;
  const m = r.method();
  if (!/POST|PUT|PATCH|DELETE/.test(m)) return;
  if (isRead(u)) return;
  const body = (r.postData() || "").slice(0, 2000);
  const rec = { at: new Date().toISOString(), method: m, url: u.replace("https://qianchuan.jinritemai.com", ""), body };
  hits.push(rec);
  console.log(`\n[CAPTURED] ${m} ${rec.url}\n  ${body}`);
  fs.writeFileSync(OUT, JSON.stringify(hits, null, 1), "utf8");
});

try {
  await page.goto("https://qianchuan.jinritemai.com/uni-prom?aavid=0000000000000000", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(8000);

  await page.evaluate((min) => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:2147483647;right:16px;top:16px;max-width:420px;padding:14px 16px;border-radius:10px;background:#111827;color:#e5e7eb;font:13px/1.6 system-ui;box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid #374151";
    d.innerHTML = "<b style='color:#7FB0FF'>捕获写操作中（" + min + " 分钟）</b><br>"
      + "挑一个计划，做一次改动并保存：<br>"
      + "- 改日预算 <code>1000 -&gt; 1001</code>，保存<br>"
      + "- 或 暂停计划 -&gt; 再启用<br>"
      + "保存后这个框会变绿。<span id='cap-n'>0</span> 条已捕获";
    document.body.appendChild(d);
    window.__capTip = d;
  }, MIN).catch(() => {});

  console.log("\nwindow opened for " + MIN + " min. 请在窗口里改一次预算，或暂停/启用一次计划。");
  console.log("写请求会实时打到这个终端，同时写进 " + OUT + "\n");

  const t0 = Date.now();
  while (Date.now() - t0 < MIN * 60000) {
    await new Promise((r) => setTimeout(r, 2000));
    if (hits.length) {
      await page.evaluate((n) => {
        const el = document.getElementById("cap-n");
        if (el) el.textContent = String(n);
        if (window.__capTip) window.__capTip.style.borderColor = "#43c98b";
      }, hits.length).catch(() => {});
    }
  }
} finally {
  console.log("\ncaptured " + hits.length + " write requests -> " + OUT);
  await ctx.close().catch(() => {});
}
