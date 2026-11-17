// 通用 HTTP JSON 连接器：任意「给个 URL 返回 JSON」的接口，用点路径取一个数。
// 配置：url、valuePath（如 data.items.0.sales）、可选的 headers / bearerEnv。
import { getJSON } from "./_http.mjs";

function pick(obj, dotted) {
  return String(dotted).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

export default {
  id: "http-json",
  agent: "shop",
  async run(cfg) {
    if (!cfg.url) return { ok: false, error: "没配 url" };
    const headers = { ...(cfg.headers || {}) };
    const token = cfg.bearerEnv ? process.env[cfg.bearerEnv] : null;
    if (token) headers.authorization = `Bearer ${token}`;

    const r = await getJSON(cfg.url, { headers });
    if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
    const v = pick(r.body, cfg.valuePath || "value");
    if (v == null) return { ok: false, error: `取值路径取不到：${cfg.valuePath}` };

    return {
      ok: true,
      value: String(v),
      extra: cfg.note || `取自 ${new URL(cfg.url).host}`,
      report: `${cfg.label || "指标"} = ${v}（${new URL(cfg.url).host}${cfg.valuePath ? " · " + cfg.valuePath : ""}）。`,
      payload: { url: cfg.url, valuePath: cfg.valuePath, value: v },
    };
  },
};
