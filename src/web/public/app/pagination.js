// Simple pagination helper. Renders prev/next + page indicator into a
// container element; exposes total + offset + hasMore state.

export function renderPagination(container, { limit, offset, total, hasMore }, onGoto) {
  const page = Math.floor(offset / limit) + 1;
  const lastPage = Math.max(1, Math.ceil(total / limit));
  container.innerHTML = "";
  const prev = document.createElement("button");
  prev.textContent = "← prev";
  prev.disabled = offset === 0;
  prev.onclick = () => onGoto(Math.max(0, offset - limit));
  const next = document.createElement("button");
  next.textContent = "next →";
  next.disabled = !hasMore;
  next.onclick = () => onGoto(offset + limit);
  const label = document.createElement("span");
  label.className = "page-label";
  label.textContent = `page ${page}/${lastPage} (${total} total)`;
  container.append(prev, label, next);
}

export function readQueryParam(name, fallback = "") {
  const p = new URLSearchParams(window.location.search);
  return p.get(name) ?? fallback;
}

export function writeQueryParams(params) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined || v === null) {
      url.searchParams.delete(k);
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  window.history.replaceState(null, "", url.toString());
}
