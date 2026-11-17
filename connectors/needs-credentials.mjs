// 需要凭证 / 需要签名的平台：先做成「闸门桩」。
// 有凭证也先不假装成功 —— 返回的 error 就是接下来要写的那一段。
// 这样 sync 会显示「缺凭证 / 未实现」，不会往界面上塞假数。

const gate = (id, agent, requires, envKeys, next) => ({
  id,
  agent,
  async run() {
    const missing = envKeys.filter((k) => !process.env[k]);
    if (missing.length) {
      return {
        ok: false,
        error: `缺凭证：${missing.join(" / ")}`,
        report: `${requires}：未接入。需要 ${missing.join("、")}。`,
      };
    }
    return {
      ok: false,
      error: `凭证已就位，但拉取逻辑还没写。下一步：${next}`,
      report: `${requires}：凭证齐了，接口层待实现。`,
    };
  },
});

export const amazonSP = gate(
  "amazon-sp",
  "shop",
  "Amazon SP-API（订单 / 流量 / 品牌分析）",
  ["SPAPI_REFRESH_TOKEN", "SPAPI_CLIENT_ID", "SPAPI_CLIENT_SECRET"],
  "① POST https://api.amazon.com/auth/o2/token 换 access_token；② 用 aws4 签名调 /orders/v0/orders 与 /reports/2021-06-30/reports；③ 映射到 metric_label=本周销售"
);

export const printful = gate(
  "printful",
  "shop",
  "Printful（每单成本 / 运费 / 物流）",
  ["PRINTFUL_API_KEY"],
  "GET https://api.printful.com/orders?status=all 取订单与 costs；GET /orders/{id} 取 shipments 拿 tracking"
);

export const douyin = gate(
  "douyin",
  "content",
  "抖音开放平台（播放 / 粉丝 / 完播）",
  ["DOUYIN_CLIENT_KEY", "DOUYIN_CLIENT_SECRET", "DOUYIN_OPEN_ID"],
  "用 client_credential 换 access_token；调 /api/douyin/v1/video/video_list 与 /user/info 取播放与粉丝"
);

export default [amazonSP, printful, douyin];
