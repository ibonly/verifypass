// Dashboard API client. Auth token held in memory only (no localStorage of
// credentials beyond the session token, which expires server-side in 8h).

let token = sessionStorage.getItem("vp_token") || null;
let tenantId = sessionStorage.getItem("vp_tenant") || null;

export function setAuth(t, tenant) {
  token = t;
  if (t) sessionStorage.setItem("vp_token", t); else sessionStorage.removeItem("vp_token");
  if (tenant) { tenantId = tenant; sessionStorage.setItem("vp_tenant", tenant); }
}

export function getToken() { return token; }

export async function apiDownload(path, filename) {
  const res = await fetch(`${__VP_API_BASE__}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {})
    }
  });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${__VP_API_BASE__}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // surface field-level validation details, not just "Invalid settings"
    const details = Array.isArray(json.error?.details?.errors)
      ? `: ${json.error.details.errors.join("; ")}`
      : "";
    const err = new Error((json.error?.message || `HTTP ${res.status}`) + details);
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}
