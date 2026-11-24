// Spindle UI — API client. Stores the operator bearer token in
// sessionStorage (cleared on tab close). On 401 we clear the token
// and re-prompt.

const TOKEN_KEY = "spindle_token";

function promptForToken() {
  const existing = sessionStorage.getItem(TOKEN_KEY) ?? "";
  const token = window.prompt(
    "Enter SPINDLE_WEB_TOKEN to access this Spindle UI:",
    existing
  );
  if (token && token.length > 0) {
    sessionStorage.setItem(TOKEN_KEY, token);
    return token;
  }
  return null;
}

export function getToken() {
  let token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) token = promptForToken();
  return token;
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function request(method, url, body) {
  const token = getToken();
  if (!token) throw new Error("no token");
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    // Force a re-prompt on next call.
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const err = new Error(
      `${method} ${url} → ${res.status}: ${
        parsed && typeof parsed === "object" && "error" in parsed
          ? parsed.error
          : text.slice(0, 200)
      }`
    );
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const api = {
  get: (url) => request("GET", url),
  post: (url, body) => request("POST", url, body ?? {}),
  patch: (url, body) => request("PATCH", url, body),
  del: (url) => request("DELETE", url),
};

export function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
