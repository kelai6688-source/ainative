// GitHub 连接器：星数 / 待处理 issue / 待处理 PR
// 公开仓库不需要 token，但未认证只有 60 次/小时。给了 GITHUB_TOKEN 就 5000/小时。
import { getJSON, num } from "./_http.mjs";

export default {
  id: "github",
  agent: "oss",
  async run(cfg) {
    const repo = cfg.repo;
    if (!repo) return { ok: false, error: "没配 repo（形如 owner/name）" };

    const headers = {};
    const token = process.env[cfg.token_env || "GITHUB_TOKEN"];
    if (token) headers.authorization = `Bearer ${token}`;

    const r = await getJSON(`https://api.github.com/repos/${repo}`, { headers });
    if (!r.ok) {
      const hint =
        r.status === 403 ? "GitHub 限流（未认证 60 次/小时）"
        : r.status === 404 ? "仓库不存在或私有"
        : r.error || `HTTP ${r.status}`;
      return { ok: false, error: hint };
    }

    const d = r.body || {};
    const [issuesR, prsR] = await Promise.all([
      getJSON(`https://api.github.com/search/issues?q=repo:${repo}+type:issue+state:open&per_page=1`, { headers }),
      getJSON(`https://api.github.com/search/issues?q=repo:${repo}+type:pr+state:open&per_page=1`, { headers }),
    ]);
    const issues = issuesR.ok ? issuesR.body?.total_count ?? 0 : null;
    const prs = prsR.ok ? prsR.body?.total_count ?? 0 : null;

    const stale = (Date.now() - new Date(d.pushed_at).getTime()) / 86400000;
    return {
      ok: true,
      value: `★${num(d.stargazers_count)}`,
      extra: `${num(d.forks_count)} fork · ${issues ?? "?"} issue · ${prs ?? "?"} PR`,
      report:
        `${repo}：★${num(d.stargazers_count)}（+${num(d.stargazers_count)} 累计）、` +
        `${num(d.forks_count)} fork；待处理 ${issues ?? "?"} issue · ${prs ?? "?"} PR；` +
        `最近推送 ${Math.round(stale)} 天前。`,
      payload: { repo, stars: d.stargazers_count, forks: d.forks_count, issues, prs, pushed_at: d.pushed_at },
    };
  },
};
