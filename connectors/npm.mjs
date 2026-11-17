// npm 连接器：某个包的周下载量。不需要任何 key，适合当「能跑通」的第一个数据源。
import { getJSON, num } from "./_http.mjs";

export default {
  id: "npm",
  agent: "oss",
  async run(cfg) {
    const pkg = cfg.package;
    if (!pkg) return { ok: false, error: "没配 package" };
    const r = await getJSON(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`);
    if (!r.ok || !r.body?.downloads && r.body?.downloads !== 0) {
      return { ok: false, error: r.error || `HTTP ${r.status}` };
    }
    const dl = r.body.downloads;
    const range = `${r.body.start} → ${r.body.end}`;
    return {
      ok: true,
      value: num(dl),
      extra: `周下载 · ${range}`,
      report: `npm 包 ${pkg} 上周下载 ${num(dl)}（${range}）。`,
      payload: { package: pkg, downloads: dl, start: r.body.start, end: r.body.end },
    };
  },
};
