#!/usr/bin/env node
// cli.mjs —— 给 Agent / 终端用的最小入口
//   node cli.mjs sweep
//   node cli.mjs state
//   node cli.mjs card --title "..." --why "..." --deliver "..." --done "..." --level P1 --owner shop --day 7
//   node cli.mjs answer --id 3 --answer agree
//   node cli.mjs read --id 2 --value 16

const BASE = process.env.AINATIVE_URL || "http://127.0.0.1:8788";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : def;
};

async function call(path, method = "GET", body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("失败:", j.error || r.status);
    process.exit(1);
  }
  return j;
}

const table = (rows) => rows.forEach((r) => console.log("  -", r));

switch (cmd) {
  case "state": {
    const s = await call("/api/state");
    console.log(`今天 ${s.today}`);
    console.log(`卡片 ${s.cards.length} · 决策 ${s.decisions.length} · 判据 ${s.criteria.length}`);
    console.log("\n要你处理的：");
    table([
      ...(s.sweep.need_decision || []).map((x) => `[P0欠决策] #${x.id} ${x.title}（${x.owner}，一步都动不了）`),
      ...s.sweep.overdue.map((x) => `[到期没动] ${x.title}（${x.owner}，已 ${x.gap} 天 / 约定第 ${x.check_day} 天）`),
      ...s.sweep.stuck.map((x) => `[卡住] ${x.title}（${x.owner}）`),
      ...s.sweep.unverified.map((x) => `[待验收] #${x.id} ${x.title}（${x.owner}）`),
      ...s.sweep.due_criteria.map((x) => `[到点读数] #${x.id} ${x.batch}（第 ${x.read_day} 天）`),
      ...s.sweep.silent_decisions.map((x) => `[没人回] #${x.id} ${x.question} → ${x.silent_default}`),
    ].concat(["（没有）"]));
    break;
  }
  case "sweep": {
    const s = await call("/api/state");
    console.log(JSON.stringify(s.sweep, null, 2));
    break;
  }
  case "card": {
    const r = await call("/api/cards", "POST", {
      title: flag("title"),
      why: flag("why"),
      deliverable: flag("deliver"),
      done_def: flag("done"),
      level: flag("level", "P1"),
      owner: flag("owner", "ceo"),
      check_day: Number(flag("day", 7)),
      actor: flag("actor", "ceo"),
    });
    console.log("已派活，卡号", r.id);
    break;
  }
  case "answer": {
    await call(`/api/decisions/${flag("id")}/answer`, "POST", {
      answer: flag("answer"),
      condition: flag("condition"),
    });
    console.log("已记进决定库");
    break;
  }
  case "read": {
    const r = await call(`/api/criteria/${flag("id")}/evaluate`, "POST", { value: Number(flag("value")) });
    console.log("读数结论:", r.verdict);
    break;
  }
  case "patrol": {
    const r = await call("/api/patrol", "POST", {});
    console.log(`第 ${r.round} 轮巡视，出手 ${r.actions.length} 次`);
    for (const a of r.actions) console.log(`  [${a.kind}] ${a.note}`);
    if (!r.actions.length) console.log("  （没有该催的、没有该报的）");
    break;
  }
  case "kb": {
    const r = await call("/api/kb/absorb", "POST", { dept: flag("dept") });
    console.log(`知识沉淀：新增 ${r.added} 条，跳过 ${r.skipped} 条（已入过）`);
    break;
  }
  case "kb-list": {
    const r = await call(`/api/kb?limit=${flag("limit", 10)}${flag("dept") ? "&dept=" + flag("dept") : ""}`);
    console.log(`共 ${r.count} 条`);
    for (const e of r.entries) console.log(`  [${e.dept}] ${e.title}`);
    break;
  }
  case "report": {
    const r = await call("/api/reports", "POST", {
      agent_id: flag("agent"),
      summary: flag("summary"),
    });
    console.log("汇报已递，编号", r.id);
    break;
  }
  case "reports": {
    const r = await call(`/api/reports?limit=${flag("limit", 10)}${flag("agent") ? "&agent=" + flag("agent") : ""}`);
    for (const x of r.reports) console.log(`  [${x.agent_id}] ${x.summary}`);
    break;
  }
  case "beat": {
    const r = await call(`/api/agents/${flag("id")}/heartbeat`, "POST", {
      metric_label: flag("label"),
      metric_value: flag("value"),
      metric_extra: flag("extra"),
      alive: flag("alive") === "0" ? false : undefined,
    });
    console.log("心跳已打，", r.last_run_at);
    break;
  }
  case "addagent": {
    const r = await call("/api/agents", "POST", {
      id: flag("id"),
      name: flag("name"),
      mandate: flag("mandate"),
      scope: flag("scope", "P2"),
    });
    console.log("新 Agent 开好了：", r.id, "（去 connectors.json 给它接数据源）");
    break;
  }
  case "rmagent": {
    await call(`/api/agents/${flag("id")}`, "DELETE");
    console.log("删掉了：", flag("id"));
    break;
  }
  case "me": {
    const p = await call("/api/profile", "POST", {
      owner: {
        ...(flag("name") ? { name: flag("name") } : {}),
        ...(flag("initial") ? { initial: flag("initial") } : {}),
        ...(flag("role") ? { role: flag("role") } : {}),
      },
    });
    console.log(`主人改好了：${p.profile.owner.name} · 头像 ${p.profile.owner.initial} · ${p.profile.owner.role}`);
    break;
  }
  case "org": {
    const p = await call("/api/profile", "POST", {
      org: {
        ...(flag("name") ? { name: flag("name") } : {}),
        ...(flag("logo") ? { logo: flag("logo") } : {}),
      },
    });
    console.log(`组织改好了：${p.profile.org.name} · logo ${p.profile.org.logo}`);
    break;
  }
  case "profile": {
    const p = await call("/api/profile");
    console.log(JSON.stringify(p, null, 2));
    break;
  }
  case "rename": {
    await call(`/api/agents/${flag("id")}/rename`, "POST", {
      name: flag("name"),
      mandate: flag("mandate"),
    });
    console.log("改好了：", flag("id"), "→", flag("name"));
    break;
  }
  case "ceo": {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const r = await promisify(execFile)(process.execPath, ["ceo.mjs", ...argv.slice(1)], {
      cwd: import.meta.dirname, windowsHide: true,
    });
    console.log(r.stdout || r.stderr);
    break;
  }
  case "ecom": {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const r = await promisify(execFile)(process.execPath, ["ecom.mjs", ...argv.slice(1)], {
      cwd: import.meta.dirname, windowsHide: true,
    });
    console.log(r.stdout || r.stderr);
    break;
  }
  case "auto": {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const r = await promisify(execFile)(process.execPath, ["auto.mjs", ...argv.slice(1)], {
      cwd: import.meta.dirname, windowsHide: true,
    });
    console.log(r.stdout || r.stderr);
    break;
  }
  case "shift": {
    const r = await call(`/api/agents/${flag("id")}/schedule`, "POST", {
      shift: JSON.parse(flag("shift", "[]")),
    });
    console.log("排班已写", JSON.stringify(r.shift));
    break;
  }
  case "brief": {
    const r = await call("/api/briefs/generate", "POST", {});
    console.log(`[${r.day}] ${r.headline}`);
    for (const i of r.items) console.log(`  ${i.label}：${i.text}`);
    console.log(`  建议：${r.suggestion}`);
    break;
  }
  default:
    console.log(`用法：
  —— 改名字（界面立刻变）——
  node cli.mjs me --name "张三" --initial "Z" --role "创始人 · 拍板定方向"
  node cli.mjs org --name "张三的工作台" --logo "ZS"
  node cli.mjs rename --id shop --name "我的店铺 Agent" --mandate "管 3 个店的数据和对账"
  node cli.mjs profile                    看当前品牌与主人

  —— 全自动 ——
  node cli.mjs auto                       跑一轮：拉数 → 判规则 → 开卡 → 巡视
  node cli.mjs auto --dry                 只算不做
  node cli.mjs auto --no-sync             不拉数，只跑规则和巡视

  —— 人（我）——
  node cli.mjs state                      今天要你处理什么
  node cli.mjs answer --id 3 --answer agree|conditional|reject|defer [--condition "…"]
  node cli.mjs read   --id 2 --value 16   到点读数（没到点会被拒）

  —— Agent 干活 ——
  node cli.mjs card --title T --why W --deliver D --done DEF --level P1 --owner shop --day 7
  node cli.mjs report --agent shop --summary "今天做了什么、卡在哪"
  node cli.mjs beat --id shop --label "本周销售" --value "$322" --extra "4 个店"
  node cli.mjs shift --id asst --shift '[{"at":"07:35","do":"扫论坛"}]'

  —— CEO ——
  node cli.mjs patrol                     巡一轮：催该催的、报该报的
  node cli.mjs brief                      生成治理侧早报
  node cli.mjs kb                         知识沉淀（把验收通过的卡落成条目）
  node cli.mjs kb-list [--dept shop]      翻知识库
  node cli.mjs sweep                      巡检原始数据`);
}
