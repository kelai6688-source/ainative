/**
 * ai-runner.mjs —— 统一调模型（文案 / 出图），所有执行器都走这里
 *
 * 配置在 ai.config.json：
 *   llm   写文案（DeepSeek 等 OpenAI 兼容）
 *   image 出图（Nano Banana / Gemini、即梦、ComfyUI 本地）
 *
 * 用法：
 *   import { chat, genImage } from "./ai-runner.mjs";
 *   const txt = await chat([{role:"user",content:"..."}]);
 *   const png = await genImage("画一张…");
 */

import fs from "node:fs";

const cfgPath = new URL("./ai.config.json", import.meta.url);

export function readAiConfig() {
  const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return { llm: c.llm || {}, image: c.image || {} };
}

const hasKey = (v) => v && v !== "<set>" && String(v).trim().length > 6;

// ── 文案 ───────────────────────────────────────────────
export async function chat(messages, opts = {}) {
  const { llm } = readAiConfig();
  if (!llm.base_url || !llm.model) throw new Error("文案模型没配：界面「模型接入」里填 base_url 和 model");
  if (!hasKey(llm.api_key) && llm.provider !== "ollama") throw new Error("文案模型没填 API Key");

  const url = `${String(llm.base_url).replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: llm.model,
    messages,
    temperature: opts.temperature ?? 0.4,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.api_key}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`文案模型报错 ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const txt = j.choices?.[0]?.message?.content;
  if (!txt) throw new Error("文案模型返回空");
  return txt;
}

// ── 出图 ───────────────────────────────────────────────
// 返回 { buffer, mime, note }
export async function genImage(prompt, opts = {}) {
  const { image } = readAiConfig();
  const provider = image.provider || "nanobanana";

  // ① Nano Banana = Google Gemini 图片模型（原生 generateContent）
  if (provider === "nanobanana" || /generativelanguage\.googleapis\.com/.test(String(image.base_url))) {
    if (!hasKey(image.api_key)) {
      throw new Error("出图模型没填 API Key（Nano Banana 用 Google AI Studio 的 key，界面「模型接入 → 图片模型」里填）");
    }
    const base = String(image.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const model = image.model || "gemini-2.5-flash-image";
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(image.api_key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], ...(opts.aspect ? { imageConfig: { aspectRatio: opts.aspect } } : {}) },
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`出图失败 ${res.status}: ${JSON.stringify(j).slice(0, 240)}`);
    const parts = j.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData || p.inline_data);
    if (!img) throw new Error("模型没返回图片（可能被安全策略拦了，换个说法再试）");
    const d = img.inlineData || img.inline_data;
    return { buffer: Buffer.from(d.data, "base64"), mime: d.mimeType || d.mime_type || "image/png", note: `${model}` };
  }

  // ② OpenAI 兼容图片接口（/images/generations）
  // ①' 魔搭 ModelScope：异步任务式（提交 → 轮询 → 拿图）
  if (provider === "modelscope") {
    if (!hasKey(image.api_key)) throw new Error("魔搭没填访问令牌（modelscope.cn → 头像 → 访问令牌）");
    const base = String(image.base_url || "https://api-inference.modelscope.cn/v1").replace(/\/$/, "");
    const model = image.model || "Qwen/Qwen-Image";

    const sub = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${image.api_key}`,
        "X-ModelScope-Async-Mode": "true",
      },
      body: JSON.stringify({ model, prompt }),
    });
    const sj = await sub.json().catch(() => ({}));
    if (!sub.ok) throw new Error(`魔搭提交失败 ${sub.status}: ${JSON.stringify(sj).slice(0, 220)}`);
    const taskId = sj.task_id || sj.data?.task_id;
    if (!taskId) throw new Error(`魔搭没返回 task_id: ${JSON.stringify(sj).slice(0, 160)}`);

    // 轮询，最多等 120 秒
    // 免费额度排队可能好几分钟，给足 5 分钟（可用 MS_TIMEOUT 覆盖）
    const deadline = Date.now() + Number(process.env.MS_TIMEOUT || 300000);
    let last = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Number(process.env.MS_POLL || 4000)));
      const q = await fetch(`${base}/tasks/${taskId}`, {
        headers: {
          authorization: `Bearer ${image.api_key}`,
          "X-ModelScope-Task-Type": "image_generation",
        },
      });
      const qj = await q.json().catch(() => ({}));
      last = qj.task_status || last;
      if (qj.task_status === "SUCCEED") {
        const url = qj.output_images?.[0];
        if (!url) throw new Error("魔搭任务成功但没给图");
        const r2 = await fetch(url);
        return { buffer: Buffer.from(await r2.arrayBuffer()), mime: "image/png", note: `${model}（魔搭）` };
      }
      if (qj.task_status === "FAILED") throw new Error(`魔搭出图失败：${JSON.stringify(qj).slice(0, 200)}`);
    }
    throw new Error(`魔搭出图超时（最后状态 ${last || "未知"}）`);
  }

  if (["openai", "jimeng", "custom", "zhipu", "siliconflow"].includes(provider)) {
    if (!hasKey(image.api_key)) throw new Error("出图模型没填 API Key");
    const url = `${String(image.base_url).replace(/\/$/, "")}/images/generations`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${image.api_key}` },
      body: JSON.stringify({ model: image.model, prompt, n: 1, size: opts.size || "1024x1024", response_format: "b64_json" }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`出图失败 ${res.status}: ${JSON.stringify(j).slice(0, 240)}`);
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) {
      const u = j.data?.[0]?.url;
      if (u) {
        const r2 = await fetch(u);
        return { buffer: Buffer.from(await r2.arrayBuffer()), mime: "image/png", note: image.model };
      }
      throw new Error("出图接口没返回图片数据");
    }
    return { buffer: Buffer.from(b64, "base64"), mime: "image/png", note: image.model };
  }

  // ③ 本地 ComfyUI（免密钥）
  if (provider === "comfy") {
    throw new Error("ComfyUI 出图还没接（先把流程导出成 API JSON 再回来）");
  }

  throw new Error(`不认识的出图 provider：${provider}`);
}

// ── 存盘 ───────────────────────────────────────────────
export function saveImage(buffer, name) {
  const dir = new URL("./media/", import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  const f = new URL(name, dir);
  fs.writeFileSync(f, buffer);
  return `media/${name}`;
}
