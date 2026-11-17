#!/usr/bin/env node
/* watch.mjs —— 轮询守护：按分钟级节奏反复拉某几个连接器，把「实时」喂给界面
 *
 *   node watch.mjs                        # 默认：所有 enabled 的连接器，60 秒一轮
 *   node watch.mjs --every 30             # 30 秒一轮
 *   node watch.mjs --connectors doudian-csv
 *   node watch.mjs --connectors doudian-csv,pdd-csv --every 45
 *   node watch.mjs --once                 # 只跑一轮（等同 sync）
 *
 * 为什么不是「真·实时」：
 *   抖店/拼多多/淘宝都不给普通开发者推 webhook 到你本机（回调地址要公网可达），
 *   而且接口有频控。所以现实做法是「秒级/分钟级增量轮询」+ SSE 推给浏览器。
 *   订单这种量级，30~60 秒足够；想更快先看平台的 QPS 和日调用限额。
 *
 * 每轮只拉指定连接器，不动别的；失败照旧写「降级」，界面保留上次数值。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const ROOT = import.meta.dirname;
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const EVERY = Math.max(10, Number(arg("every", 60)));   // 最少 10 秒，防手抖打爆频控
// 单轮超时：原来写死 120 秒，但订单全量翻页 50 页要 3 分钟以上，
// 每轮都被掐 → 日志里永远是「拉取失败：Command failed」，数据泵等于没跑。
// 现在按增量翻页（一般 1~3 页），仍给足 10 分钟余量；可用 WATCH_TIMEOUT_MS 覆盖。
const TIMEOUT_MS = Math.max(30000, Number(process.env.WATCH_TIMEOUT_MS || 600000));
const ONCE = argv.includes("--once");
const CONNS = (arg("connectors", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

const stamp = () => new Date().toISOString().replace("T", " ").slice(11, 19);

async function tick(n) {
  const args = [path.join(ROOT, "sync.mjs"), ...CONNS];
  try {
    // windowsHide 必开：execFile 在 Windows 上默认会给子进程分配新控制台，
    // 每轮 tick 都弹一个黑框（标题就是 node.exe 全路径）。开了就只是后台跑。
    const { stdout } = await run(process.execPath, args, {
      cwd: ROOT, timeout: TIMEOUT_MS, windowsHide: true,
    });
    // sync.mjs 打的是 [OK] / [X]，不是 ✓ / ✗ —— 之前这里匹配错，日志永远「0 成功 / 0 失败」
    const lines = stdout.split("\n").filter((l) => /^\[(OK|X)\]/.test(l.trim()));
    const ok = lines.filter((l) => l.trim().startsWith("[OK]")).length;
    const bad = lines.length - ok;
    const brief = lines.map((l) => l.trim().replace(/\s+/g, " ")).join(" | ");
    console.log(`[${stamp()}] #${n}  ${ok} 成功 / ${bad} 失败  ${brief.slice(0, 260)}`);
  } catch (e) {
    console.log(`[${stamp()}] #${n}  拉取失败：${String(e.message || e).slice(0, 160)}`);
  }
}

function stop() {
  console.log(`\n[${stamp()}] 停止轮询（共跑了 ${round} 轮）。`);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let round = 0;
console.log(`watch: 每 ${EVERY}s 拉一次 ${CONNS.length ? CONNS.join(",") : "全部 enabled 连接器"}（Ctrl+C 停）`);

await tick(++round);
if (ONCE) process.exit(0);

setInterval(() => tick(++round), EVERY * 1000);
