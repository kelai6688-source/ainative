// 淘宝 / 天猫开放平台（TOP）  open.taobao.com
// 网关：https://eco.taobao.com/router/rest
// 签名：MD5(app_secret + 排序拼接 + app_secret) 转大写，见 _open-platform.mjs
// 需要：TAOBAO_APP_KEY / TAOBAO_APP_SECRET + 店铺授权拿到的 TAOBAO_SESSION（top session key）
import { signMd5, beijingStamp, postForm, sortedConcat } from "./_open-platform.mjs";
import { num } from "./_http.mjs";

const GW = "https://eco.taobao.com/router/rest";

export default {
  id: "taobao",
  agent: "taobao",
  async run(cfg) {
    const appKey = process.env.TAOBAO_APP_KEY;
    const secret = process.env.TAOBAO_APP_SECRET;
    const session = process.env.TAOBAO_SESSION;
    const missing = [
      ["TAOBAO_APP_KEY", appKey],
      ["TAOBAO_APP_SECRET", secret],
      ["TAOBAO_SESSION", session],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return {
        ok: false,
        error: `缺凭证：${missing.join(" / ")}`,
        report: `淘宝未接入（缺 ${missing.join("、")}）。去 https://open.taobao.com 建应用 → 申请「交易」权限 → 店铺授权拿 top session。`,
      };
    }

    const params = {
      method: cfg.method || "taobao.trades.sold.get",
      app_key: appKey,
      session,
      timestamp: beijingStamp(),
      format: "json",
      v: "2.0",
      sign_method: "md5",
      ...(cfg.param || { fields: "tid,status,payment", page_no: 1, page_size: 1, status: "WAIT_SELLER_SEND_GOODS" }),
    };
    params.sign = signMd5(params, secret);

    const r = await postForm(GW, params);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${r.error || ""}`.trim() };

    const b = r.body || {};
    if (b.error_response) {
      const e = b.error_response;
      return { ok: false, error: `平台报错 ${e.code} ${e.msg}（方法名/权限以开放平台文档为准）` };
    }
    const d = Object.values(b)[0] || {};
    const total = d.total_results ?? d.total ?? (Array.isArray(d.trades) ? d.trades.length : null);
    if (total === null) return { ok: false, error: `没找到 total_results：${JSON.stringify(b).slice(0, 160)}` };

    return {
      ok: true,
      value: num(total),
      extra: `${params.method} · 待发货`,
      report: `淘宝：待发货 ${num(total)} 笔（${params.method}）。`,
      payload: { method: params.method, total },
    };
  },
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()) && process.argv.includes("--selftest")) {
  const s = { app_key: "tb_test", format: "json", method: "taobao.trades.sold.get", sign_method: "md5", timestamp: "2026-11-16 15:00:00", v: "2.0" };
  console.log("拼接串:", sortedConcat(s));
  console.log("md5 sign:", signMd5(s, "test_secret"));
}
