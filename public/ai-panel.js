// 模型接入面板：读配置 → 填表 → 测试 → 保存（普通脚本，挂 window.initAiDialog）
window.initAiDialog = function initAiDialog({ api, toast, $ }) {
  let DATA = null;

  const fill = (sel, list, cur) => {
    sel.innerHTML = list.map((p) => `<option value="${p.id}"${p.id === cur ? " selected" : ""}>${p.name}</option>`).join("");
  };

  async function load() {
    DATA = await api("/api/settings/ai");
    const { llm, image, presets } = DATA;

    fill($("#ai-llm-provider"), presets.llm, llm.provider);
    fill($("#ai-img-provider"), presets.image, image.provider);

    $("#ai-llm-base").value = llm.base_url || "";
    $("#ai-llm-model").value = llm.model || "";
    $("#ai-llm-key").value = "";
    $("#ai-llm-key").placeholder = llm.has_key ? `已存 ${llm.key_masked}（留空=不改）` : "本地 Ollama 不用填";
    $("#ai-llm-state").textContent = llm.has_key ? "已配置密钥" : (llm.provider === "ollama" ? "本地免密钥" : "未配置");
    $("#ai-llm-state").className = `ai-state ${llm.has_key || llm.provider === "ollama" ? "ok" : "bad"}`;

    $("#ai-img-base").value = image.base_url || "";
    $("#ai-img-model").value = image.model || "";
    $("#ai-img-key").value = "";
    $("#ai-img-key").placeholder = image.has_key ? `已存 ${image.key_masked}（留空=不改）` : "OpenAI 兼容时填";
    $("#ai-img-ak").value = image.access_key || "";
    $("#ai-img-sk").value = "";
    $("#ai-img-sk").placeholder = image.secret_key ? "已存（留空=不改）" : "火山引擎 SK";
    $("#ai-img-state").textContent = image.has_key ? "已配置密钥" : (image.provider === "comfy" ? "本地免密钥" : "未配置");
    $("#ai-img-state").className = `ai-state ${image.has_key || image.provider === "comfy" ? "ok" : "bad"}`;

    $("#ai-hint").textContent = DATA.updated_at ? `上次保存 ${String(DATA.updated_at).replace("T", " ").slice(0, 16)}` : "还没配置过";
  }

  // 选服务商时把默认 base_url / model 带出来
  const onPick = (kind) => () => {
    const id = $(kind === "llm" ? "#ai-llm-provider" : "#ai-img-provider").value;
    const p = (DATA?.presets?.[kind] || []).find((x) => x.id === id);
    if (!p) return;
    if (p.base_url) $(kind === "llm" ? "#ai-llm-base" : "#ai-img-base").value = p.base_url;
    if (p.model) $(kind === "llm" ? "#ai-llm-model" : "#ai-img-model").value = p.model;
  };

  function collect() {
    return {
      llm: {
        provider: $("#ai-llm-provider").value,
        base_url: $("#ai-llm-base").value.trim(),
        model: $("#ai-llm-model").value.trim(),
        api_key: $("#ai-llm-key").value.trim(),
      },
      image: {
        provider: $("#ai-img-provider").value,
        base_url: $("#ai-img-base").value.trim(),
        model: $("#ai-img-model").value.trim(),
        api_key: $("#ai-img-key").value.trim(),
        access_key: $("#ai-img-ak").value.trim(),
        secret_key: $("#ai-img-sk").value.trim(),
      },
    };
  }

  async function test(kind) {
    const btn = $(kind === "llm" ? "#ai-llm-test" : "#ai-img-test");
    const msg = $(kind === "llm" ? "#ai-llm-msg" : "#ai-img-msg");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "测…";
    msg.className = "ai-msg";
    msg.textContent = "正在连…";
    try {
      // 先保存再测，否则测的是旧配置
      await api("/api/settings/ai", "POST", collect());
      const r = await api("/api/settings/ai/test", "POST", { kind });
      msg.className = `ai-msg ${r.ok ? "ok" : "bad"}`;
      msg.textContent = `${r.ok ? "✔" : "✘"} ${r.message}（${r.latency_ms}ms）`;
    } catch (e) {
      msg.className = "ai-msg bad";
      msg.textContent = `✘ ${e.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      await load();
    }
  }

  $("#ai-llm-provider").addEventListener("change", onPick("llm"));
  $("#ai-img-provider").addEventListener("change", onPick("image"));
  $("#ai-llm-test").addEventListener("click", () => test("llm"));
  $("#ai-img-test").addEventListener("click", () => test("image"));
  $("#ai-cancel").addEventListener("click", () => $("#aidlg").close());

  $("#ai-ok").addEventListener("click", async () => {
    try {
      await api("/api/settings/ai", "POST", collect());
      $("#aidlg").close();
      toast("模型配置已保存（只存在本机）");
    } catch (e) {
      toast(e.message, true);
    }
  });

  return async function openAiDialog() {
    await load();
    $("#aidlg").showModal();
  };
};
