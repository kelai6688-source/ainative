/**
 * connectors/qianchuan.mjs —— 巨量千川「全域推广」账户/计划采集
 *
 * 用已有的抖店登录态（.browser/doudian）：千川和抖店同 SSO，不用单独扫码。
 * 实测账户：示例店铺 aavid=0000000000000000
 *
 * 走的是千川自己的接口（页面里 fetch，带 cookie）：
 *   POST /ad/api/pmc/v1/uni-promotion/ad/list-required   计划列表（名称/预算/目标ROI/状态/学习期）
 *   POST /ad/api/data/v1/common/statQuery                计划维度指标（消耗/成交/ROI/每单成本）
 *   GET  /ad/api/v1/account/finance/get-adv-balance       账户余额
 *   GET  /ad/api/v1/account/daily-budget/get-account-budget 账户日预算
 *
 * 单位坑（踩过）：金额字段是 **1e-5 元**。61631000 → ¥616.31（和后台首页一致）。
 * 所以统一 /100000，别拿它当分。
 *
 * 已知边界：
 *   ① 素材维度（material_id）接口不认，会超时 → v1 只能到「计划 + 商品 + 日趋势」。
 *   ② 写操作（调价/改预算/关停）接口没抓到，v1 不猜、不调 —— 只出建议 + 决策包。
 */

import { openProfile } from "./_browser.mjs";

const A = "0000000000000000";
const TO_YUAN = (v) => (v == null ? null : Number(v) / 100000);
const day = (d) => d.toISOString().slice(0, 10);

async function api(page, path, body) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, {
      method: b ? "POST" : "GET",
      headers: b ? { "content-type": "application/json" } : undefined,
      credentials: "include",
      body: b ? JSON.stringify(b) : undefined,
    });
    return await r.json().catch(() => ({}));
  }, { p: path, b: body });
}

const METRICS = [
  "stat_cost",
  "total_prepay_and_pay_order_roi2",
  "total_pay_order_gmv_include_coupon_for_roi2",
  "total_pay_order_count_for_roi2",
  "total_cost_per_pay_order_for_roi2",
];

async function statByAd(page, startTime, endTime) {
  const body = {
    Dimensions: ["ad_id"],
    StartTime: startTime,
    EndTime: endTime,
    OrderBy: [{ Type: 2, Field: "stat_cost" }],
    DataSetKey: "site_promotion_list",
    Metrics: METRICS,
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: "advertiser_id", Operator: 7, Values: [A] },
        { Field: "pricing_category", Operator: 7, Values: ["2"] },
      ],
    },
    FilterParams: { promotion_overview: ["1"] },
  };
  const j = await api(page, "/ad/api/data/v1/common/statQuery?reqFrom=ainative", body);
  const rows = j?.data?.StatsData?.Rows || j?.data?.Rows || [];
  const map = new Map();
  for (const r of rows) {
    const id = r?.Dimensions?.ad_id?.ValueStr || r?.Dimensions?.ad_id?.Value;
    if (!id) continue;
    const m = r.Metrics || {};
    map.set(String(id), {
      cost: m.stat_cost?.Value ?? null,
      roi_goal_hit: m.total_prepay_and_pay_order_roi2?.Value ?? null,
      gmv: m.total_pay_order_gmv_include_coupon_for_roi2?.Value ?? null,
      orders: m.total_pay_order_count_for_roi2?.Value ?? null,
      cost_per_order: m.total_cost_per_pay_order_for_roi2?.Value ?? null,
    });
  }
  return map;
}

export default {
  id: "qianchuan",
  agent: "tc",
  async run(cfg) {
    const ctx = await openProfile(cfg.site || "doudian", { headless: true }).catch((e) => { globalThis.__e = e.message; return null; });
    if (!ctx) return { ok: false, error: globalThis.__e || "打不开 profile" };

    // 模式二：素材库（视频）——审核状态 / 质量标签 / 投放状态
    if (cfg.mode === "materials") {
      try {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto(`https://qianchuan.jinritemai.com/tools/creative-management/video-library?aavid=${A}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(7000);
        if (/login|passport|sso/i.test(page.url())) return { ok: false, error: "千川登录态没了" };

        const d2 = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
        const qs = new URLSearchParams({
          page: "1", pageSize: String(Number(cfg.maxItems || 50)),
          orderBy: "2", field: "create_time",
          queryString: "", source: "", tags: "", imageModes: "", analysisType: "", from: "2",
          // 这串 metrics 是素材库页面自己带的，缺了 materialStatsData 就是空对象
          metrics: "stat_cost,total_prepay_and_pay_order_roi2,total_cvr_rate_for_roi2,total_convert_rate_for_roi2,prepay_and_pay_order_roi,ctr,ecp_convert_rate",
          metricsStartTime: `${d2(7)} 00:00:00`, metricsEndTime: `${d2(1)} 23:59:59`,
          auditStatuses: "", materialDeliveryStatus: "", aavid: A,
        });
        const j = await api(page, `/ad/api/creation/material/video-list?${qs.toString()}`);
        const vids = j?.data?.personalVideos || [];
        if (!vids.length) return { ok: false, error: "素材库没返回视频（可能为空或接口改了）" };

        const stat = (v, key) => {
          const m = v.materialStatsData || {};
          return m?.normalStatsData?.[key]?.value ?? m?.roi2StatsData?.[key]?.value ?? m?.metrics?.[key]?.value ?? null;
        };
        const rows = vids.map((v) => ({
          item_id: v.itemId,
          title: String(v.title || "").slice(0, 160),
          duration: v.duration ?? null,
          audit: v.auditStatus ?? null,
          delivery: v.materialDeliveryStatus ?? null,
          low_eff: v.lowEfficiency ? 1 : 0,
          high_q: v.highQuality ? 1 : 0,
          improvable: v.improvable ? 1 : 0,
          cost: stat(v, "statCost"),
          roi: stat(v, "prepayAndPayOrderRoi"),
          ctr: stat(v, "ctr"),
          cvr: stat(v, "ecpConvertRate"),
          stats: JSON.stringify(v.materialStatsData || {}),
          raw: JSON.stringify({ ...v, videoUrl: undefined, imageUrl: undefined }).slice(0, 3000),
          at: new Date().toISOString(),
        }));

        // 审核状态码（对着页面核对过）：1=通过，2=不通过，0=待审/未知
        const passed = rows.filter((r) => r.audit === 1).length;
        const failed = rows.filter((r) => r.audit === 2).length;
        const pending = rows.length - passed - failed;
        return {
          ok: true,
          value: `${rows.length} 条素材`,
          extra: `素材库 ${rows.length} 条 · 通过 ${passed} / 不通过 ${failed}${pending ? ` / 待审 ${pending}` : ""}`,
          report: `千川素材库：${rows.length} 条视频，审核通过 ${passed}、不通过 ${failed}${pending ? `、待审 ${pending}` : ""}`,
          payload: { kind: "materials", materials: rows, total: j?.data?.total ?? rows.length },
        };
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(`https://qianchuan.jinritemai.com/uni-prom?aavid=${A}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(6000);
      if (/login|passport|sso/i.test(page.url())) return { ok: false, error: "千川登录态没了 → 用抖店号重新登一次" };

      // 1) 计划列表（全域：MarGoal=1 / AdlabMode=1 / AdlabScene=1）
      const list = await api(page, "/ad/api/pmc/v1/uni-promotion/ad/list-required", {
        _origin_ajax_: 1, UseNewChain: true,
        Params: {
          SophonxDataSetKey: "site_promotion_list",
          AdFilter: {
            MarGoal: 1, AdlabMode: 1, AdlabScene: 1, SmartBidType: 0,
            NotInEcpAdStatuses: ["delete", "frozen", "system_disable", "time_done"],
            DataTimeRange: { StartTime: `${day(new Date(Date.now() - 7 * 86400000))} 00:00:00`, EndTime: `${day(new Date())} 23:59:59` },
          },
          OrderBy: { Field: "stat_cost", Type: 2 },
          PageParams: { Page: 1, PageSize: 50 },
          Metrics: ["stat_cost"],
          ListAdsModules: [24, 7, 36, 37, 47, 46, 48],
        },
        aavid: A,
      });
      const infos = list?.data?.adInfos || [];
      if (list?.code !== 0 && list?.code !== undefined) {
        return { ok: false, error: `计划列表失败：${list?.msg || list?.code}` };
      }

      // 2) 指标：今天 + 近7天
      const now = new Date();
      const todayStart = `${day(now)} 00:00:00`;
      const nowStr = `${day(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
      const d7 = `${day(new Date(Date.now() - 6 * 86400000))} 00:00:00`;
      const d30 = `${day(new Date(Date.now() - 29 * 86400000))} 00:00:00`;
      const statToday = await statByAd(page, todayStart, nowStr);
      const stat7 = await statByAd(page, d7, `${day(now)} 23:59:59`);
      const stat30 = await statByAd(page, d30, `${day(now)} 23:59:59`);

      // 3) 账户：余额 / 日预算
      const bal = await api(page, `/ad/api/v1/account/finance/get-adv-balance?aavid=${A}`);
      const budget = await api(page, `/ad/api/v1/account/daily-budget/get-account-budget?aavid=${A}`);
      const balance = TO_YUAN(bal?.data?.balanceInfos?.["1"]?.total ?? null);
      const accountBudget = TO_YUAN(budget?.data?.accountBudget?.budget ?? null);

      // 4) 合并
      const rows = infos.map((a) => {
        const id = String(a.id);
        const t = statToday.get(id) || { cost: 0, gmv: 0, orders: 0 };
        const s = stat7.get(id) || { cost: 0, gmv: 0, orders: 0 };
        const s30 = stat30.get(id) || { cost: 0, gmv: 0, orders: 0 };
        const cost = t.cost ?? 0, gmv = t.gmv ?? 0;
        return {
          ad_id: id,
          name: a.name,
          status: a.adDeliveryName || null,
          budget: TO_YUAN(a.budget),
          roi_goal: a.ecpRoi2Goal ?? null,
          mar_goal: a.marGoal ?? null,
          adlab_mode: a.adlabMode ?? null,
          learning: a.learningPhase ?? 0,
          cost: cost ?? 0,
          gmv: gmv ?? 0,
          orders: t.orders ?? 0,
          cost_per_order: t.cost_per_order ?? null,
          roi: cost > 0 ? +(gmv / cost).toFixed(2) : null,
          cost_7d: s.cost ?? null,
          gmv_7d: s.gmv ?? null,
          roi_7d: s.cost > 0 ? +(s.gmv / s.cost).toFixed(2) : null,
          orders_7d: s.orders ?? null,
          cost_30d: s30.cost ?? null,
          gmv_30d: s30.gmv ?? null,
          roi_30d: s30.cost > 0 ? +(s30.gmv / s30.cost).toFixed(2) : null,
          orders_30d: s30.orders ?? null,
          raw: JSON.stringify({ ad: a, today: t, d7: s, d30: s30 }),
          at: new Date().toISOString(),
        };
      });

      const costToday = rows.reduce((x, r) => x + (r.cost || 0), 0);
      const gmvToday = rows.reduce((x, r) => x + (r.gmv || 0), 0);
      const ordersToday = rows.reduce((x, r) => x + (r.orders || 0), 0);
      const roiToday = costToday > 0 ? +(gmvToday / costToday).toFixed(2) : null;
      const running = rows.filter((r) => /投放中|已开启|启用/.test(String(r.status))).length;

      if (!rows.length) {
        return { ok: false, error: "没有全域计划（MarGoal=1）—— 账户可能只开了标准投放，或计划全被删" };
      }

      return {
        ok: true,
        value: `${running} 个在投`,
        extra: `余额 ¥${balance ?? "?"} · 今日消耗 ¥${costToday.toFixed(2)} · ROI ${roiToday ?? "—"} · 计划 ${rows.length}`,
        report: `千川：${running}/${rows.length} 个计划在投，今日消耗 ¥${costToday.toFixed(2)}、成交 ¥${gmvToday.toFixed(2)}、ROI ${roiToday ?? "—"}、${ordersToday} 单；余额 ¥${balance ?? "?"}`,
        payload: {
          balance, accountBudget, costToday, gmvToday, roiToday, ordersToday,
          plans: rows.length, running, rows,
        },
      };
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
