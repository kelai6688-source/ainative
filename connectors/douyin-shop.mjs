// 抖店（抖音电商小店）连接器
//
// 平台：抖店开放平台  https://openapi-fxg.jinritemai.com
// 和「抖音开放平台」(open.douyin.com，内容侧) 不是一回事，别搞混：
//   · 抖音开放平台 = 视频 / 粉丝 / 播放  → connectors/douyin.mjs（内容 Agent）
//   · 抖店开放平台 = 订单 / 商品 / 售后 / 结算 → 本文件（电商 Agent）
//
// 需要三个东西（缺一个就跑不了，缺了会明说，不会瞎编）：
//   DOUYIN_SHOP_APP_KEY      自研应用 / ISV 应用的 app_key
//   DOUYIN_SHOP_APP_SECRET   对应的 app_secret（用来算 sign）
//   DOUYIN_SHOP_ACCESS_TOKEN 店铺授权后拿到的 access_token
//
// 签名规则（v2 接口，md5 模式）：
//   1. 取所有请求参数（去掉 sign、去掉空值），按 key 升序
//   2. 拼成 key1value1key2value2…（不是 k=v&k=v，是直接连写）
//   3. sign = MD5(app_secret + 拼好的串 + app_secret)，转大写
//   hmac-sha256 模式：sign = HMAC_SHA256(拼好的串, app_secret)，转十六进制小写
//
// 自测：node connectors/douyin-shop.mjs --selftest
//   会打印一组固定样本的签名（不需要任何凭证），可以拿去和官方文档对。

import crypto from "node:crypto";
import { getJSON, num } from "./_http.mjs";

const HOST = process.env.DOUYIN_SHOP_HOST || "https://openapi-fxg.jinritemai.com";

function sortedConcat(params) {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => k + params[k])
    .join("");
}

export function sign(params, secret, method = "md5") {
  const raw = sortedConcat(params);
  if (method === "hmac-sha256") {
    return crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  }
  return crypto.createHash("md5").update(secret + raw + secret, "utf8").digest("hex").toUpperCase();
}

function stamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 平台要北京时间
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function call(method, paramObj, { appKey, appSecret, accessToken, signMethod = "md5" }) {
  const params = {
    app_key: appKey,
    method,
    param_json: JSON.stringify(paramObj || {}),
    timestamp: stamp(),
    v: "2",
    sign_method: signMethod,
  };
  if (accessToken) params.access_token = accessToken;
  params.sign = sign(params, appSecret, signMethod);

  // v2 的路径就是 method 里的点换斜杠：order.searchList → /order/searchList
  const url = `${HOST}/${method.replace(/\./g, "/")}?` + new URLSearchParams(params).toString();
  return getJSON(url);
}

export default {
  id: "douyin-shop",
  agent: "shop",
  async run(cfg) {
    const appKey = process.env[cfg.appKeyEnv || "DOUYIN_SHOP_APP_KEY"];
    const appSecret = process.env[cfg.appSecretEnv || "DOUYIN_SHOP_APP_SECRET"];
    const accessToken = process.env[cfg.tokenEnv || "DOUYIN_SHOP_ACCESS_TOKEN"];

    const missing = [
      ["DOUYIN_SHOP_APP_KEY", appKey],
      ["DOUYIN_SHOP_APP_SECRET", appSecret],
      ["DOUYIN_SHOP_ACCESS_TOKEN", accessToken],
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) {
      return {
        ok: false,
        error: `缺凭证：${missing.join(" / ")}`,
        report:
          `抖店未接入（缺 ${missing.join("、")}）。` +
          `去 https://op.jinritemai.com 建自研应用 → 申请「订单」「商品」「售后」权限 → 店铺授权拿 access_token。`,
      };
    }

    // 默认拉「待发货订单数」；方法名以开放平台文档为准，可在 connectors.json 里覆盖
    const method = cfg.method || "order.searchList";
    const param = cfg.param || {
      page: 0,
      size: 1,
      order_by: "create_time",
      order_asc: false,
      // 待发货
      order_status: 2,
    };

    const r = await call(method, param, {
      appKey, appSecret, accessToken,
      signMethod: cfg.signMethod || "md5",
    });

    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status} ${r.error || ""}`.trim() };
    }

    const body = r.body || {};
    // 抖店返回结构大致是 { code:0, msg:"", data:{ ... } }
    if (body.code !== undefined && Number(body.code) !== 0) {
      return {
        ok: false,
        error: `平台返回 code=${body.code} ${body.msg || ""}（若 4004/方法不存在，把 connectors.json 里的 method 换成文档里的实际方法名）`,
      };
    }

    const data = body.data || body;
    const total = data.total ?? data.count ?? (Array.isArray(data.list) ? data.list.length : null);
    if (total === null) {
      return { ok: false, error: `没在返回里找到 total/count，检查 method 与权限：${JSON.stringify(body).slice(0, 160)}` };
    }

    return {
      ok: true,
      value: num(total),
      extra: `${method} · 待发货`,
      report: `抖店：待发货订单 ${num(total)} 单（${method}）。`,
      payload: { method, param, total },
    };
  },
};

// ── 自测：不碰网络，只验证签名链 ─────────────────────────
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  if (process.argv.includes("--selftest")) {
    const sample = {
      app_key: "6880xxxx",
      method: "order.searchList",
      param_json: '{"page":0,"size":1,"order_status":2}',
      timestamp: "2026-11-16 15:00:00",
      v: "2",
      sign_method: "md5",
    };
    const md5Sign = sign(sample, "test_secret", "md5");
    const hmacSign = sign(sample, "test_secret", "hmac-sha256");
    const again = sign(sample, "test_secret", "md5");

    console.log("排序后拼接串：");
    console.log("  " + sortedConcat(sample));
    console.log("md5        sign :", md5Sign);
    console.log("hmac-sha256 sign:", hmacSign);
    console.log("确定性      :", md5Sign === again ? "OK（两次一致）" : "FAIL");
    console.log("\n注意：这是本地自算值，只能用来核对「你的实现/我的实现」是否一致；");
    console.log("      真实请求的 sign 取决于你那次请求的 timestamp/param_json，每次都不一样。");
  } else {
    console.log("用法：node connectors/douyin-shop.mjs --selftest");
  }
}
