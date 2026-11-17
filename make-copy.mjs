/**
 * make-copy.mjs —— 出文案：标题 / 卖点 / 详情页文字
 *
 * 用法：
 *   node make-copy.mjs --item 0000000000000000000            # 给这个商品出 5 个标题
 *   node make-copy.mjs --item 0000000000000000000 --type detail  # 出详情页文案
 *   node make-copy.mjs --card 33                              # 直接按卡干，干完自动交活
 *
 * 铁律：模型只能看给它的商品真数（价格、规格、已卖、毛利），不许编。
 */

import fs from "node:fs";
import { db } from "./db.mjs";
import { chat } from "./ai-runner.mjs";

const SHOP = "shop_demo";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : null; };
const ITEM = arg("item");
const CARD = arg("card") ? Number(arg("card")) : null;
const TYPE = arg("type") || "title";

function productFacts(itemId) {
  const p = db.prepare("SELECT * FROM products WHERE shop = ? AND item_id = ?").get(SHOP, itemId);
  if (!p) throw new Error(`库里没有这个商品：${itemId}`);
  const skus = db.prepare("SELECT spec, price, stock, sku_id FROM skus WHERE shop = ? AND item_id = ?").all(SHOP, itemId);
  const orders = db.prepare("SELECT COUNT(*) n FROM orders WHERE shop = ? AND item_id = ?").get(SHOP, itemId);
  return {
    商品ID: itemId,
    现有标题: p.title,
    价格区间: p.price_min && p.price_max ? `¥${p.price_min}~${p.price_max}` : "缺",
    规格: skus.map((s) => ({ 规格: s.spec, 价: s.price, 库存: s.stock })),
    库存合计: skus.reduce((a, b) => a + (Number(b.stock) || 0), 0),
    能关联到该商品的订单数: orders.n,
  };
}

async function makeTitle(f) {
  const sys = `你是抖店爆款标题优化师，懂抖音搜索。铁律：
1. 只依据我给的商品事实，不许编造功效、产地、认证。
2. 标题 30 字以内（抖店标题上限），前 12 字必须含核心搜索词。
3. 每版标题后面标注它主打哪个搜索意图（早餐 / 囤货 / 低脂 / 家庭 / 免煮…）。
4. 输出 Markdown 表格，不要寒暄。`;
  const user = `商品事实：
${JSON.stringify(f, null, 2)}

请出 5 个标题方案，覆盖不同搜索意图，并说明每个方案替换掉现有标题里的什么问题。
表格列：序号 | 标题 | 主打意图 | 与现有标题的差异`;
  return chat([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.7 });
}

async function makeDetail(f) {
  const sys = `你是抖店详情页文案。铁律：
1. 只写事实里有的卖点，功效不许编。
2. 结构：首屏一句话钩子 → 3 个卖点（每个一行，带具体数字）→ 规格表格 → 食用场景 → 收尾一句。
3. 中文口语，别用"匠心""甄选"这类空词。
4. 输出 Markdown。`;
  const user = `商品事实：
${JSON.stringify(f, null, 2)}

写一版详情页文案。缺的卖点写「待补」，不要编。`;
  return chat([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.6 });
}

const itemId = ITEM || (CARD ? (() => {
  const c = db.prepare("SELECT title FROM cards WHERE id = ?").get(CARD);
  // 从卡标题里找不到具体商品，默认用第一个商品
  const p = db.prepare("SELECT item_id FROM products WHERE shop = ? LIMIT 1").get(SHOP);
  console.log(`卡 #${CARD}：${c ? c.title : "?"} → 用商品 ${p.item_id}`);
  return p.item_id;
})() : null);

if (!itemId) {
  console.log("用法：node make-copy.mjs --item <商品ID> [--type title|detail]");
  process.exit(1);
}

const f = productFacts(itemId);
console.log(`商品：${f.现有标题.slice(0, 30)}…  价 ¥${f.价格区间}  库存 ${f.库存合计}\n`);

const md = TYPE === "detail" ? await makeDetail(f) : await makeTitle(f);
const file = `文案_${itemId}_${TYPE}.md`;
fs.writeFileSync(file, `# ${TYPE === "detail" ? "详情页文案" : "标题方案"} · ${itemId}\n\n> 商品：${f.现有标题}\n> 生成：DeepSeek\n\n---\n\n${md}`, "utf8");
console.log(md);
console.log(`\n已写出：${file}`);

// 按卡干的话，顺手交活
if (CARD) {
  const r = await fetch(`http://127.0.0.1:8788/api/cards/${CARD}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by: "ai", note: `已出 ${TYPE === "detail" ? "详情页文案" : "5 个标题方案"}`, evidence: file }),
  });
  console.log("交活：", r.status, await r.text());
}
