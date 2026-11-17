// CSV / TSV 连接器：任何能在本机落成文件的数都能进台账。
// 配置：path + 取值方式（value 列名 / sum 某列 / count 行数 / 按 where 过滤后聚合）
import fs from "node:fs";
import path from "node:path";
import { num } from "./_http.mjs";

function parse(text, sep) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { head: [], rows: [] };
  const head = lines[0].split(sep).map((s) => s.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(sep);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
  return { head, rows };
}

export default {
  id: "csv",
  agent: "shop",
  async run(cfg) {
    const p = path.resolve(cfg.path || "");
    if (!cfg.path || !fs.existsSync(p)) return { ok: false, error: `文件不存在：${cfg.path}` };
    const sep = cfg.sep || (p.endsWith(".tsv") ? "\t" : ",");
    const { head, rows } = parse(fs.readFileSync(p, "utf8"), sep);
    if (!head.length) return { ok: false, error: "表头读不出来" };

    let picked = rows;
    if (cfg.where) {
      const [k, v] = cfg.where.split("=");
      picked = rows.filter((r) => String(r[k]).includes(v));
    }

    let value, how;
    if (cfg.sum) {
      const n = picked.reduce((a, r) => a + (Number(String(r[cfg.sum]).replace(/[^\d.\-]/g, "")) || 0), 0);
      value = num(Math.round(n * 100) / 100); how = `sum(${cfg.sum})`;
    } else if (cfg.count) {
      value = num(picked.length); how = `count(rows)`;
    } else {
      const col = cfg.value || head[head.length - 1];
      const last = picked[picked.length - 1];
      if (!last) return { ok: false, error: "过滤后没有行" };
      value = String(last[col]); how = `${col}(最后一行)`;
    }

    return {
      ok: true,
      value,
      extra: `${how} · ${picked.length} 行`,
      report: `${path.basename(p)}：${cfg.label || "指标"} = ${value}（${how}，${picked.length} 行${cfg.where ? "，过滤 " + cfg.where : ""}）。`,
      payload: { file: p, head, rows: picked.length, how },
    };
  },
};
