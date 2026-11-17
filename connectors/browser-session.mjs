// 浏览器会话采集器：用 login.mjs 存下的 profile，打开一个页面，按选择器取一个数
//
// 这不是 API。它读的是「你自己登录状态下看到的页面」。
// 适用：平台没开放接口、或接口审核要等很久，但你今天就想看到数。
//
// connectors.json 里这样配：
//   {
//     "id": "doudian-browser", "module": "browser-session", "agent": "dyshop",
//     "label": "待发货", "enabled": true,
//     "site": "doudian",
//     "url": "https://fxg.jinritemai.com/ffa/morder/order/list",
//     "selector": "text=待发货",
//     "pick": "number",              // number=从文本里抠第一个数字；text=原样
//     "wait": 8000
//   }
//
// 注意：
//   · 选择器写不准就抓不到 —— 用 login.mjs 那个窗口 F12 自己看，别猜。
//   · 页面慢就加 wait；SPA 没渲染完抓到的会是空。
//   · 定时别太密（≥5 分钟），后台不是给你程序刷的。

import path from "node:path";
import { createRequire } from "node:module";
import { openProfile } from "./_browser.mjs";

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_DIR, "playwright", "playwright"].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  throw new Error("找不到 playwright，设置 PLAYWRIGHT_DIR");
}

// 本地时间 HH:mm —— 别用 toISOString，那是 UTC，会差 8 小时
const localHM = () => new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);

const pickNumber = (s) => {  const m = String(s).replace(/[,，\s]/g, "").match(/(\d+(?:\.\d+)?)\s*(万|亿)?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2] === "万") n *= 1e4;
  if (m[2] === "亿") n *= 1e8;
  return n;
};

export default {
  id: "browser-session",
  agent: "dyshop",
  async run(cfg) {
    const site = cfg.site || "doudian";
    const profile = path.join(import.meta.dirname, "..", ".browser", site);
    if (!cfg.url) return { ok: false, error: "没配 url" };
    if (!cfg.selector) return { ok: false, error: "没配 selector（要抓页面上哪一段）" };

    let chromium;
    try { ({ chromium } = loadPlaywright()); }
    catch (e) { return { ok: false, error: e.message }; }

    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: "chrome",
        locale: "zh-CN",
        viewport: { width: 1400, height: 900 },
        args: ["--no-sandbox"],
      });
    } catch (e) {
      return { ok: false, error: `打不开 profile（先跑 node login.mjs --site ${site}）：${String(e.message).slice(0, 80)}` };
    }

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

      const wait = Number(cfg.wait || 8000);
      let found = false;

      // 等「关键字出现」比等选择器稳：抖店那套类名带 hash，改版就废
      if (cfg.waitText) {
        try {
          await page.waitForFunction((t) => (document.body?.innerText || "").includes(t), cfg.waitText, { timeout: wait });
          found = true;
        } catch {}
        if (!found) {
          const cur0 = page.url();
          return { ok: false, error: `等不到文字「${cfg.waitText}」（页面没渲染完 / 没登录 / 改版）`, payload: { url: cur0 } };
        }
        // 再多给一点时间让数字填进去
        await page.waitForTimeout(1200);
      } else {
        try {
          await page.waitForSelector(cfg.selector, { timeout: wait });
          found = true;
        } catch {}
      }

      const cur = page.url();
      if (/login|passport|sso/i.test(cur)) {
        return { ok: false, error: "被踢回登录页：会话过期了，重跑 node login.mjs 扫一次" };
      }

      // 时间窗：抖店首页的「实时」其实是个下拉框（.tabSelect / aurora-select），
      // 点开后选「近1天 / 近7天 / 近30天」，经营数据才会换成那个区间。
      const tab = process.env.ECOM_TAB || cfg.tab || null;
      let tabClicked = null;
      let tabNote = null;
      if (tab) {
        const current = await page.evaluate(() =>
          (document.querySelector('[class*="tabSelect"]')?.innerText || "").trim()).catch(() => "");

        if (current !== tab) {
          // 注意：这个下拉框只认真鼠标事件，evaluate 里 el.click() 打不开
          const handle = await page.$('[class*="tabSelect"]').catch(() => null);
          let opened = false;
          if (handle) {
            await handle.click().catch(() => {});
            opened = true;
          } else {
            const box = await page.evaluate(() => {
              const el = [...document.querySelectorAll('[class*="aurora-select"]')]
                .find((e) => /实时|近1天|近7天|近30天|大促/.test(e.innerText || ""));
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }).catch(() => null);
            if (box) { await page.mouse.click(box.x, box.y); opened = true; }
          }

          if (!opened) {
            // 没有时间窗的页面（比如演示店、别家平台）：按当前数据抓，注明一下
            if (cfg.requireTab) return { ok: false, error: "这个页面没有时间窗下拉框（页面改版了？）" };
            tabClicked = null;
            tabNote = `页面无时间窗，按当前数据`;
          } else {
            await page.waitForTimeout(900);

            // 选项在 .aurora-select-item-option-content 里，按坐标点最稳
            const optBox = await page.evaluate((label) => {
              const els = [...document.querySelectorAll('.aurora-select-item-option-content,[class*="select-item-option"]')]
                .filter((e) => (e.innerText || "").trim() === label);
              const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }, tab).catch(() => null);

            if (!optBox) {
              if (cfg.requireTab) return { ok: false, error: `下拉框里没有「${tab}」这一项` };
              tabNote = `下拉框里没有「${tab}」，按当前数据`;
            } else {
              await page.mouse.click(optBox.x, optBox.y);
              tabClicked = tab;
              await page.waitForTimeout(Number(cfg.tabWait || 4500));
            }
          }
        } else {
          tabClicked = tab;
        }
      }
      if (!found) {
        return { ok: false, error: `等不到选择器「${cfg.selector}」（没登录 / 页面改版 / 选择器写错）`, payload: { url: cur } };
      }

      // 用 innerText（只取看得见的文字），别用 textContent —— 后者会把内联脚本也读进来
      const readRaw = async () => (await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return "";
        return (el.innerText || el.textContent || "").trim();
      }, cfg.selector)) || "";

      let raw = await readRaw();
      // 抖店首页有几个模块是懒渲染的（搜索/短视频/直播），第一次读常常还没有。
      // 再等一会儿读第二次，两段拼起来匹配，避免把它们误判成「未取到」。
      await page.waitForTimeout(1800);
      const raw2 = await readRaw();
      if (raw2 && raw2.length > raw.length) raw = `${raw}\n${raw2}`;
      let text = raw;

      // 一次开页面，抓多个数：metrics 里每条一个正则，省得开 6 次浏览器
      if (Array.isArray(cfg.metrics) && cfg.metrics.length) {
        const subs = [];
        for (const m of cfg.metrics) {
          let re;
          try { re = new RegExp(m.regex); }
          catch { subs.push({ key: m.key, label: m.label, value: null, ok: false, extra: "regex 写错" }); continue; }
          const mm = raw.replace(/\r/g, "").match(re);
          let v = mm ? (mm[1] ?? mm[0]) : null;
          // 抖店大数字会写成 9.6万 / 1.2亿 —— 直接取数字会把 9.6万 读成 9
          if (mm && mm[2]) {
            const mult = mm[2] === "亿" ? 1e8 : mm[2] === "万" ? 1e4 : 1;
            v = String(Math.round(Number(mm[1]) * mult * 100) / 100);
          }
          // 三态，不要一律标「失败」：
          //   ok=true  value 有值      → 正常
          //   ok=true  value="-"       → 页面上这一项就是空的（比如凌晨刚过，实时窗口没有数据）
          //   ok=false value=null      → 页面上根本没这个词 / 正则没匹配到（这才是真问题）
          if (v != null) {
            subs.push({ key: m.key, label: m.label || m.key, value: String(v), ok: true, main: !!m.main });
          } else {
            const i = raw.indexOf(m.label || m.key);
            const tail = i >= 0 ? raw.slice(i + String(m.label || m.key).length, i + String(m.label || m.key).length + 12) : "";
            const blank = /^\s*[-—–]\s*/.test(tail) || /^\s*0\b/.test(tail);
            subs.push({
              key: m.key, label: m.label || m.key,
              value: blank ? "-" : null,
              ok: blank,
              extra: blank ? "页面为空" : "页面没这一项",
              main: !!m.main,
            });
          }
        }
        const mainSub = subs.find((s) => s.main) || subs[0];
        if (!mainSub || mainSub.value == null) {
          return { ok: false, error: `主指标没抓到（${(mainSub && mainSub.label) || "?"}），页面可能没渲染完`, payload: { subs } };
        }
        return {
          ok: true,
          value: String(mainSub.value),
          extra: `${site} 页面 · ${tabClicked ? tabClicked + " · " : tabNote ? tabNote + " · " : ""}${localHM()}`,
          subs,
          report: `${site}：` + subs.map((s) => `${s.label}=${s.ok ? s.value : "—"}`).join(" · "),
          payload: { site, url: cfg.url, tab: tabClicked, metrics: subs.length, raw: raw.replace(/\s+/g, " ").slice(0, 400) },
        };
      }

      // 配了 regex 就按正则抽，比依赖带 hash 的类名稳得多。
      if (cfg.regex) {
        let re;
        try { re = new RegExp(cfg.regex, cfg.regexFlags || ""); }
        catch (e) { return { ok: false, error: `regex 写错了：${String(e.message).slice(0, 60)}` }; }
        const m = raw.match(re);
        if (!m) return { ok: false, error: `regex 没匹配到：「${raw.replace(/\s+/g, " ").slice(0, 60)}」`, payload: { regex: cfg.regex } };
        text = m[1] ?? m[0];
      }

      const value = cfg.pick === "text" ? text.trim() : pickNumber(text);
      if (value === null || value === "") {
        return { ok: false, error: `抓到了元素但里面没有数字：「${String(text).slice(0, 40)}」` };
      }

      return {
        ok: true,
        value: String(value),
        extra: `${site} 页面 · ${tabClicked ? tabClicked + " · " : tabNote ? tabNote + " · " : ""}${localHM()}`,
        report: `${site} 后台页面采集：${cfg.label || "指标"} = ${value}（来源：${new URL(cfg.url).host}，浏览器会话，不是 API）`,
        payload: { site, url: cfg.url, selector: cfg.selector, regex: cfg.regex || null, raw: raw.replace(/\s+/g, " ").slice(0, 200) },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
