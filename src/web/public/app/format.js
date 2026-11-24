// Formatting helpers shared across UI pages.

export function formatTs(ms) {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export function relativeTs(ms) {
  if (ms === null || ms === undefined) return "—";
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatTs(ms);
}

export function clip(text, max = 120) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function kindBadge(kind) {
  const k = kind ?? "?";
  return `<span class="badge kind-${escapeHtml(k)}">${escapeHtml(k)}</span>`;
}

export function visibilityBadge(vis) {
  const v = vis ?? "?";
  return `<span class="badge vis-${escapeHtml(v)}">${escapeHtml(v)}</span>`;
}

export function tombstonedBadge(tsAt) {
  if (tsAt === null || tsAt === undefined) return "";
  return `<span class="badge tombstoned">tombstoned</span>`;
}

export function priorityBadge(priority) {
  if (!priority) return "";
  return `<span class="badge priority-${escapeHtml(priority)}">${escapeHtml(priority)}</span>`;
}

export function inboxStatusBadge(status) {
  if (!status) return "";
  return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function deliveryBadge(status) {
  if (!status) return "";
  return `<span class="badge delivery-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function formatBytes(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function compactTriggerBadge(trigger) {
  if (!trigger) return '<span class="muted">—</span>';
  const cls = {
    pi_auto: "trigger-pi-auto",
    nudge_threshold: "trigger-nudge",
    nudge_cadence: "trigger-nudge",
    user_manual: "trigger-manual",
  }[trigger] ?? "trigger-other";
  const label = {
    pi_auto: "pi auto",
    nudge_threshold: "nudge",
    nudge_cadence: "cadence",
    user_manual: "manual",
  }[trigger] ?? trigger;
  return `<span class="badge ${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
}

/** Inline % fill bar. pct is 0–100 or null. */
export function contextBar(pct) {
  if (pct === null || pct === undefined) return '<span class="muted">—</span>';
  const p = Math.min(100, Math.max(0, pct));
  const color = p >= 80 ? "var(--danger)" : p >= 60 ? "var(--warn)" : "var(--ok)";
  return `<span class="ctx-bar" title="${p.toFixed(1)}%">` +
    `<span class="ctx-bar-fill" style="width:${p.toFixed(1)}%;background:${color}"></span>` +
    `</span><span class="mono" style="font-size:0.85em">${p.toFixed(1)}%</span>`;
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
