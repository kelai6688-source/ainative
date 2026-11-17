// 通用小工具：带超时、带 UA、错误不抛出去只返回
export async function getJSON(url, { headers = {}, timeout = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        "user-agent": "ainative-kernel/0.1 (+local)",
        accept: "application/json",
        ...headers,
      },
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: r.ok, status: r.status, body, headers: Object.fromEntries(r.headers) };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function postJSON(url, body, { timeout = 10000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export const num = (n) => Number(n).toLocaleString("en-US");
