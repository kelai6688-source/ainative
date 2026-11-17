#!/usr/bin/env node
/* keepalive.mjs —— 看门狗：服务 / 指标泵 / 数据泵 任一个没了就拉起来
 *
 *   node keepalive.mjs           # 常驻，每 60 秒查一次
 *   node keepalive.mjs --once    # 只查一次（给开机脚本用）
 *
 * 为什么需要：服务被反复重启过，也会因异常退出。用户只关心「页面还能不能开」，
 * 所以必须有东西自愈，而不是等人来问。
 */

import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 8788);
const ONCE = process.argv.includes("--once");
const LOG = path.join(ROOT, "logs", "keepalive.log");
const INTERVAL = 60 * 1000;

const stamp = () => new Date().toLocaleString("zh-CN", { hour12: false });
function say(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch {}
}

// -- 端口检测（服务是否活着） -----------------------------
const portUp = () => new Promise((resolve) => {
  const s = new net.Socket();
  s.setTimeout(1500);
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("timeout", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(false));
  s.connect(PORT, "127.0.0.1");
});

// -- 进程检测（泵是否活着） -------------------------------
function nodeCmds() {
  return new Promise((resolve) => {
    // 注意引号：外层用双引号包 -Command，里面就别再出现双引号，否则 PowerShell 会解析错，
    // 结果就是「查不到进程 -> 误判 -> 重复拉起泵」。实测踩过这个坑。
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { $_.CommandLine }";
    exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout || "")));
  });
}

function launch(args, out, err) {
  const o = fs.openSync(path.join(ROOT, "logs", out), "a");
  const e = fs.openSync(path.join(ROOT, "logs", err), "a");
  const child = spawn(process.execPath, args, {
    cwd: ROOT, detached: true, stdio: ["ignore", o, e], windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function check() {
  const acts = [];

  // 1) 服务
  if (!(await portUp())) {
    const pid = launch(["server.mjs"], "server.log", "server.err.log");
    acts.push(`服务没在跑 -> 拉起(pid ${pid})`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 2) 两条泵（靠命令行里的标识判断，避免误判外壳进程）
  const cmds = await nodeCmds();
  const lines = cmds.split(/\r?\n/).filter((l) => l && !l.includes("runner.js"));

  const hasMetrics = lines.some((l) => l.includes("watch.mjs") && l.includes("shop_demo-browser"));
  const hasData = lines.some((l) => l.includes("watch.mjs") && l.includes("doudian-orders"));
  const hasMarket = lines.some((l) => l.includes("watch.mjs") && l.includes("compass-"));

  if (!hasMetrics) {
    const pid = launch(["watch.mjs", "--connectors", "shop_demo-browser", "--every", "300"], "watch-metrics.log", "watch-metrics.err.log");
    acts.push(`指标泵没了 -> 拉起(pid ${pid})`);
  }
  if (!hasData) {
    const pid = launch(["watch.mjs", "--connectors", "doudian-orders,doudian-products", "--every", "600"], "watch-data.log", "watch-data.err.log");
    acts.push(`数据泵没了 -> 拉起(pid ${pid})`);
  }
  // 市场泵：罗盘榜单 + 精选联盟爆款榜。爆款榜「实时」要相对新，2 小时一轮；
  // 罗盘那两条顺带一起跑（各 7~12 秒，不费事）。
  if (!hasMarket) {
    const pid = launch(["watch.mjs", "--connectors", "compass-cate-mining,compass-rank-goods,buyin-hot,buyin-hot-all", "--every", "7200"], "watch-market.log", "watch-market.err.log");
    acts.push(`市场泵没了 -> 拉起(pid ${pid})`);
  }

  if (acts.length) acts.forEach((a) => say(a));
  return acts.length;
}

async function main() {
  say(`看门狗启动：每 ${INTERVAL / 1000} 秒检查服务 + 两条泵${ONCE ? "（单次）" : ""}`);
  const n = await check();
  if (!n) say("全部在跑，无需动作");
  if (ONCE) return;
  setInterval(() => { check().catch((e) => say(`检查出错：${e.message}`)); }, INTERVAL);

// ── 自动循环：CEO 巡视 / 电商分析 / AI 领卡，按间隔自己跑 ──
// 环境变量 AINATIVE_AUTO_MIN 控制间隔（分钟），设 0 关闭
const AUTO_MIN = Number(process.env.AINATIVE_AUTO_MIN ?? 30);

function runAutoRound() {
  const out = fs.openSync(path.join(ROOT, "logs", "auto.log"), "a");
  const p = spawn(process.execPath, ["auto.mjs", "--no-sync"], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, out], windowsHide: true,
  });
  p.unref();
  say(`自动循环已启动（pid ${p.pid}）`);
}

if (AUTO_MIN > 0) {
  // 启动先补一轮（如果上次跑超过 25 分钟）
  const lastFile = path.join(ROOT, "logs", "auto.log");
  let stale = true;
  try { stale = (Date.now() - fs.statSync(lastFile).mtimeMs) / 60000 > Math.max(25, AUTO_MIN - 5); } catch {}
  if (stale) setTimeout(runAutoRound, 15000);

  setInterval(() => {
    try { runAutoRound(); } catch (e) { say(`自动循环启动失败：${e.message}`); }
  }, AUTO_MIN * 60000);
  say(`自动循环每 ${AUTO_MIN} 分钟一轮（AINATIVE_AUTO_MIN 可改，0=关）`);
} else {
  say("自动循环已关闭（AINATIVE_AUTO_MIN=0）");
}
}

main();
