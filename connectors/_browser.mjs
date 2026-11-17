// 打开已登录的浏览器 profile —— 进程间排队 + 失败重试
//
// 为什么要有这个：Chrome 的持久化 profile 同一时刻只能被一个进程打开。
// 两个数据泵（指标 5 分钟 / 订单商品 10 分钟）撞在一起时，第二个会直接报
// 「Target page, context or browser has been closed」，看起来像登录失效，
// 其实是并发锁。这里用文件锁排队，后到的等前一个关掉再进。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [
    process.env.PLAYWRIGHT_DIR,
    "playwright",
    "playwright",
  ].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  throw new Error("找不到 playwright，设置 PLAYWRIGHT_DIR");
}

const RETRY_RE = /ProcessSingleton|SingletonLock|正在使用|already in use|Failed to create|Target page, context or browser has been closed/i;

function lockPathOf(site) {
  return path.join(import.meta.dirname, "..", ".browser", `${site}.lock`);
}

async function acquireLock(site, timeoutMs = 120000) {
  const file = lockPathOf(site);
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(file, "wx");          // 原子创建，抢到就算拿到
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch {} };
    } catch (e) {
      // 陈旧的锁（进程已经死了）直接清掉
      try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs > 3 * 60 * 1000) { fs.unlinkSync(file); continue; }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error("等不到 profile 锁（另一个任务一直占着）");
      await sleep(1200);
    }
  }
}

export async function openProfile(site, opts = {}) {
  const { chromium } = loadPlaywright();
  const profile = path.join(import.meta.dirname, "..", ".browser", site);
  const release = await acquireLock(site);
  const attempts = Number(opts.attempts || 3);
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const ctx = await chromium.launchPersistentContext(profile, {
        headless: opts.headless !== false,
        channel: "chrome",
        locale: "zh-CN",
        viewport: opts.viewport || { width: 1500, height: 950 },
        args: ["--no-sandbox"],
      });
      // 关上下文时顺手放锁
      const origClose = ctx.close.bind(ctx);
      ctx.close = async (...a) => { try { return await origClose(...a); } finally { release(); } };
      return ctx;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      if (RETRY_RE.test(msg) && i < attempts) { await sleep(2500 * i); continue; }
      break;
    }
  }

  release();
  throw new Error(
    `打不开 profile（site=${site}）：${String(lastErr?.message || lastErr).slice(0, 140)}。` +
    `先确认已扫码登录，并保证没有别的程序开着这个 profile。`
  );
}
