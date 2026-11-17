/**
 * make-image.mjs —— 出主图 / 详情页图
 *
 * 用法：
 *   node make-image.mjs --item 0000000000000000000 --type main     # 5 张主图
 *   node make-image.mjs --item 0000000000000000000 --type detail   # 3 屏详情页
 *   node make-image.mjs --card 33 --type main                      # 按卡干，干完交活
 *
 * 出图模型在 ai.config.json 的 image 段：
 *   provider  nanobanana（Google Gemini 图片）| openai | jimeng | comfy
 *   api_key   Nano Banana 用 Google AI Studio key
 *   model     gemini-2.5-flash-image
 *
 * 文字不交给模型画（中文必糊），只让模型铺底图，文案用 Canvas/HTML 后期叠。
 */

import fs from "node:fs";
import { db } from "./db.mjs";
import { genImage, saveImage, readAiConfig } from "./ai-runner.mjs";

const SHOP = "shop_demo";
const arg = (k) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : null; };
const ITEM = arg("item");
const CARD = arg("card") ? Number(arg("card")) : null;
const TYPE = arg("type") || "main";

function productOf(itemId) {
  const p = db.prepare("SELECT * FROM products WHERE shop = ? AND item_id = ?").get(SHOP, itemId);
  if (!p) throw new Error(`库里没有这个商品：${itemId}`);
  const skus = db.prepare("SELECT spec, price FROM skus WHERE shop = ? AND item_id = ?").all(SHOP, itemId);
  return { p, skus };
}

// 主图 5 张的构图（抖音规范，1:1）
function mainPrompts(p) {
  const name = String(p.title).slice(0, 20);
  return [
    { key: "1-白底主图", prompt: `电商白底产品主图，${name}，纯白背景，正面平铺，硬纸袋包装略带褶皱质感，自然柔光，无文字，无logo，居中构图，商业摄影级清晰` },
    { key: "2-场景图", prompt: `中式家庭早餐场景，木桌上摆一盘薄饼卷菜，旁边一碗热粥，暖色晨光从窗边照进来，俯视 45 度，${name}包装放在桌角可见，写实摄影，无文字` },
    { key: "3-规格对比", prompt: `同一产品的三种规格包装并排摆放在浅灰背景上，从矮到高排列，大小差异明显，柔光棚拍，无文字，商业产品图` },
    { key: "4-原料特写", prompt: `小麦面粉与刚做好的薄饼特写，面粉撒在深色木板上，薄饼半透明有光泽，微距镜头，浅景深，暖调，无文字` },
    { key: "5-信任背书", prompt: `食品生产车间干净的操作台，一摞整齐叠放的薄饼，白手套正在整理，明亮整洁，轻微景深，无文字，无品牌` },
  ];
}

// 详情页 3 屏（竖版 3:4）
function detailPrompts(p) {
  const name = String(p.title).slice(0, 20);
  return [
    { key: "1-首屏钩子", prompt: `竖版电商详情页首屏背景，暖木色台面上一叠金黄薄饼，蒸汽微微升起，留出上方 1/3 空白给文案，写实美食摄影，无文字` },
    { key: "2-吃法展示", prompt: `竖版生活场景图，双手正在把菜卷入薄饼，桌面有葱丝黄瓜条，家常菜板，暖光，俯拍，留白给文案，无文字` },
    { key: "3-规格说明", prompt: `竖版浅灰背景产品展示，三袋不同规格的薄饼包装平铺，角度整齐，底部留白给参数表，无文字，干净电商风` },
  ];
}

const itemId = ITEM || (CARD ? db.prepare("SELECT item_id FROM products WHERE shop = ? LIMIT 1").get(SHOP).item_id : null);
if (!itemId) { console.log("用法：node make-image.mjs --item <商品ID> [--type main|detail]"); process.exit(1); }

const { p } = productOf(itemId);
const list = TYPE === "detail" ? detailPrompts(p) : mainPrompts(p);

// 先检查 key，缺就直说，不要跑到一半才炸
const { image } = readAiConfig();
const need = ["nanobanana", "openai", "jimeng", "custom"].includes(image.provider || "nanobanana");
if (need && !(image.api_key && image.api_key.length > 6)) {
  console.log(`出不了图：${image.provider || "nanobanana"} 还没填 API Key。`);
  console.log(`填法：界面右上「模型接入」→ 图片模型 → 选 ${image.provider || "nanobanana"} → 粘 key → 保存 → 测试`);
  console.log(`或直接改 ai.config.json 的 image.api_key（当前 model=${image.model || "gemini-2.5-flash-image"}）`);
  process.exit(2);
}

console.log(`商品：${String(p.title).slice(0, 30)}…`);
console.log(`要出 ${list.length} 张（${TYPE === "detail" ? "详情页" : "主图"}）\n`);

const done = [];
for (const it of list) {
  const t0 = Date.now();
  try {
    process.stdout.write(`▶ ${it.key} … `);
    const r = await genImage(it.prompt, { aspect: TYPE === "detail" ? "3:4" : "1:1" });
    const name = `${itemId}_${it.key}.png`;
    const rel = saveImage(r.buffer, name);
    const kb = Math.round(r.buffer.length / 1024);
    console.log(`OK ${kb}KB ${((Date.now() - t0) / 1000).toFixed(1)}s → ${rel}`);
    done.push({ key: it.key, rel, prompt: it.prompt });
  } catch (e) {
    console.log(`失败：${String(e.message || e).slice(0, 140)}`);
  }
}

if (done.length) {
  const md = [`# ${TYPE === "detail" ? "详情页" : "主图"} · ${itemId}`, "", `商品：${p.title}`, "", "| 图 | 文件 | 用的提示词 |", "|---|---|---|"];
  for (const d of done) md.push(`| ${d.key} | ${d.rel} | ${d.prompt.slice(0, 50)}… |`);
  md.push("", "> 文字别让模型画（中文必糊）：底图出来后用模板叠字。", "> 上架前必须人工看图：食品类画错外观算虚假宣传。");
  const file = `出图_${itemId}_${TYPE}.md`;
  fs.writeFileSync(file, md.join("\n"), "utf8");
  console.log(`\n清单：${file}`);
}

if (CARD) {
  const r = await fetch(`http://127.0.0.1:8788/api/cards/${CARD}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ by: "ai", note: `已出 ${done.length} 张${TYPE === "detail" ? "详情页" : "主图"}，待你验图`, evidence: `出图_${itemId}_${TYPE}.md` }),
  });
  console.log("交活：", r.status, await r.text());
}
