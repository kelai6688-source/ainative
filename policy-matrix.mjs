import fs from "node:fs";

// ═══ 授权矩阵：一类任务只问一次，之后 CEO 照你的选择自动处理 ═══
let d = fs.readFileSync("db.mjs", "utf8");
if (!d.includes("task_policies")) {
  d = d.replace(
    "-- 结算账单：抖店「资金-账单管理-结算账单」逐笔抓下来",
    `-- 授权矩阵：同一类任务只问一次，之后按这里的选择自动走
--   mode: auto = CEO/AI 全权处理（只在台账留痕）
--         human = 每次都交人
--         ask   = 每次问（默认，等于没定）
CREATE TABLE IF NOT EXISTS task_policies (
  category   TEXT PRIMARY KEY,      -- 任务类别（改标题 / 停投 / 售后 / 参数 / 链接合并 …）
  mode       TEXT NOT NULL,         -- auto | human | ask
  decided_by TEXT,                  -- 谁定的
  note       TEXT,                  -- 当时怎么说的
  decided_at TEXT
);

-- 结算账单：抖店「资金-账单管理-结算账单」逐笔抓下来`
  );
  fs.writeFileSync("db.mjs", d);
  console.log("[db] task_policies 表已加");
}

// 任务归类：把标题归到稳定类别（决定「问一次」的粒度）
const CATS = [
  ["改标题", /标题|长尾词|文案|主图|详情|文案/],
  ["停投", /停投|投放|费比|千川|计划/],
  ["定价", /提价|降价|定价|改价|毛利率|尝鲜装/],
  ["售后", /售后|退款|补发|驳回/],
  ["发货", /发货|寄件|物流单|打单/],
  ["参数", /参数|填.|扣点|成本|物流|包装/],
  ["链接管理", /链接|重复铺货|合并|上架|下架/],
  ["数据源", /数据源|token|接口|抓取|连接器/],
  ["内容运营", /视频|直播|达人|内容|选题/],
  ["知识沉淀", /知识|沉淀|复盘|模板/],
];

const classifyCategory = (title) => {
  const t = String(title || "");
  for (const [name, re] of CATS) if (re.test(t)) return name;
  return "其他";
};

// 读策略（不存在 = ask）
const getPolicy = (db, category) => {
  const r = db.prepare("SELECT * FROM task_policies WHERE category = ?").get(category);
  return r || { category, mode: "ask", decided_by: null, note: null };
};

const setPolicy = (db, category, mode, by, note) => {
  db.prepare(
    `INSERT INTO task_policies (category,mode,decided_by,note,decided_at) VALUES (?,?,?,?,?)
     ON CONFLICT(category) DO UPDATE SET mode=excluded.mode, decided_by=excluded.decided_by,
       note=excluded.note, decided_at=excluded.decided_at`
  ).run(category, mode, by || "S", note || "", new Date().toISOString());
};

export { classifyCategory, getPolicy, setPolicy, CATS };
console.log("[lib] 归类与策略读写已导出");
