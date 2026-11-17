// 拼多多开放平台（open.pinduoduo.com）
// 网关：https://gw-api.pinduoduo.com/api/router
// 签名：MD5(client_secret + 排序拼接 + client_secret) 转大写，见 _open-platform.mjs
// 需要：PDD_CLIENT_ID / PDD_CLIENT_SECRET（自研应用），店铺授权后部分接口还要 access_token
import { signMd5, beijingStamp, postForm, sortedConcat } from "./_open-platform.mjs";
import { num } from "./_http.mjs";

const GW = "https://gw-api.pinduoduo.com/api/router";

export default {
  id: "pdd",
  agent: "pdd",
  async run(cfg) {
    const clientId = process.env.PDD_CLIENT_ID;
    const secret = process.env.PDD_CLIENT_SECRET;
    const token = process.env.PDD_ACCESS_TOKEN;
    const missing = [["PDD_CLIENT_ID", clientId], ["PDD_CLIENT_SECRET", secret]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return {
        ok: false,
        error: `缺凭证：${missing.join(" / ")}`,
        report: `拼多多未接入（缺 ${missing.join("、")}）。去 https://open.pinduoduo.com 建自研应用 → 申请「订单」权限 → 店铺授权。`,
      };
    }

    const params = {
      type: cfg.method || "pdd.order.list.get",
      client_id: clientId,
      timestamp: beijingStamp(),
      data_type: "JSON",
      ...(cfg.param || { order_status: 2, page: 1, page_size: 1 }),
    };
    if (token) params.access_token = token;
    params.sign = signMd5(params, secret);

    const r = await postForm(GW, params);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.error || ""}`.trim() };

    const b = r.body || {};
    if (b.error_response) {
      const e = b.error_response;
      return { ok: false, error: `平台报错 ${e.error_code} ${e.error_msg}（方法名以开放平台文档为准）` };
    }
    const d = Object.values(b)[0] || {};
    const total = d.total_count ?? d.total ?? (Array.isArray(d.order_list) ? d.order_list.length : null);
    if (total === null) return { ok: false, error: `没找到 total_count：${JSON.stringify(b).slice(0, 160)}` };

    return {
      ok: true,
      value: num(total),
      extra: `${params.type} · 待发货`,
      report: `拼多多：待发货订单 ${num(total)} 单（${params.type}）。`,
      payload: { method: params.type, total },
    };
  },
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()) && process.argv.includes("--selftest")) {
  const s = { client_id: "pdd_test", data_type: "JSON", timestamp: "2026-11-16 15:00:00", type: "pdd.order.list.get" };
  console.log("拼接串:", sortedConcat(s));
  console.log("md5 sign:", signMd5(s, "test_secret"));
}
