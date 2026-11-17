#!/usr/bin/env node
/* login.mjs —— 扫码/登录一次，把浏览器会话存到本地，之后定时复用（全自动，不用按回车）
 *
 *   node login.mjs --site doudian
 *   node login.mjs --site doudian --url https://fxg.jinritemai.com/login/common
 *   node login.mjs --site doudian --done-url /ffa/          # 出现这个路径就算登录成功
 *
 * 它怎么判断你登录好了：
 *   打开有头浏览器 → 你在里面扫码 → 它每 1.5 秒看一眼地址：
 *     · 不再停留在登录页（login / passport / sso / signin）
 *     · 且地址里出现了 --done-url（配了才检查）
 *   两个都满足就保存 profile 并自动关窗。也可以用 --timeout 强制等多久（默认 300 秒）。
 *
 * 也可以从界面上点「扫码登录」触发（服务端会 spawn 这个脚本）。
 */

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const SITE = arg("site", "doudian");
const URL_ = arg("url", {
  doudian: "https://fxg.jinritemai.com/login/common",
  taobao: "https://login.taobao.com/member/login.jhtml",
  pdd: "https://mms.pinduoduo.com/login/",
  buyin: "https://buyin.jinritemai.com/login/common",
  "buyin-select": "https://buyin.jinritemai.com/dashboard/select-goods/hot-rank",
}[SITE] || "https://fxg.jinritemai.com/login/common");
const DONE = arg("done-url", "");
const TIMEOUT = Number(arg("timeout", 300)) * 1000;
const LOGIN_RE = /login|passport|sso|signin|sign-in|account\/auth/i;

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_DIR, "playwright", "playwright"].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  throw new Error("找不到 playwright。设置 PLAYWRIGHT_DIR 指向含 playwright 的 node_modules");
}

const { chromium } = loadPlaywright();
const PROFILE = path.join(import.meta.dirname, ".browser", SITE);
fs.mkdirSync(PROFILE, { recursive: true });

console.log(`[login] site=${SITE} 打开 ${URL_}`);
console.log(`[login] profile=${PROFILE}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: "chrome",
  locale: "zh-CN",
  viewport: { width: 1280, height: 860 },
  args: ["--no-sandbox"],
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

const started = Date.now();
let ok = false;
let lastWhy = "";

while (Date.now() - started < TIMEOUT) {
  await new Promise((r) => setTimeout(r, 1500));
  // 扫码后站点经常**另开一个标签**（达人首页），原来只盯第一个页面就会一直停在 /login，
  // 明明已经登录还判失败。所以每轮把所有标签都看一遍。
  let pages = [];
  try { pages = ctx.pages(); } catch { break; }

  let cur = "";
  let okPage = null;
  for (const p of pages) {
    let u = "";
    try { u = p.url(); } catch { continue; }
    if (!cur) cur = u;
    if (LOGIN_RE.test(u)) continue;                       // 还在登录页，跳过
    if (DONE && !u.includes(DONE)) continue;              // 不满足目标路径
    if (/douyinec\.com/.test(u)) continue;                // 被甩到营销页 = 没登录
    const t = await p.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 600)).catch(() => "");
    if (/加入抖音电商，激发兴趣/.test(t)) continue;        // 入驻营销页
    if (!/佣金|爆款|选品广场|达人|工作台|我的/.test(t)) continue;
    okPage = { u, p };
    break;
  }

  if (okPage) {
    ok = true;
    console.log(`[login] ✓ 已登录：${okPage.u}（标签 ${pages.length} 个）`);
    break;
  }
  if (Math.floor((Date.now() - started) / 15000) !== Math.floor((Date.now() - started - 1500) / 15000)) {
    console.log(`[login] 等待扫码登录… ${Math.round((Date.now() - started) / 1000)}s（当前 ${cur.slice(0, 80)}）`);
  }
}

const cookies = await ctx.cookies();
fs.writeFileSync(path.join(PROFILE, "meta.json"), JSON.stringify({
  site: SITE, url: URL_, done_url: DONE, login_at: new Date().toISOString(), ok,
  cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
}, null, 2), "utf8");

console.log(`[login] ${ok ? "成功" : "超时"}：存下 ${cookies.length} 条 cookie`);
if (!ok) console.log(`[login] 没检测到登录完成。可以重跑，或用 --timeout 加时间。`);
await ctx.close().catch(() => {});
process.exit(ok ? 0 : 2);
