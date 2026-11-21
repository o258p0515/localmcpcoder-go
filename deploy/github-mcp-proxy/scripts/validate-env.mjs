import { createSign } from "node:crypto";

const env = process.env;
const errors = [];
const warnings = [];
const add = (name, reason, fix, example) => errors.push({ name, reason, fix, example });
const email = env.CF_API_EMAIL || "";
const apiKey = env.CF_API_KEY || "";
const domain = env.CF_DOMAIN || "";
const mcpToken = env.MCP_TOKEN || "";

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  add("CF_API_EMAIL", "Thiếu hoặc sai định dạng email.", "Nhập email Cloudflare dùng cho Global API Key.", "dev@example.com");
}
if (apiKey.length < 30 || /\s/.test(apiKey)) {
  add("CF_API_KEY", "Global API Key thiếu hoặc không hợp lệ.", "Tạo Global API Key đủ quyền Zone Read, DNS Read/Edit và Workers KV Edit.", "<Cloudflare Global API Key>");
}
if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domain)) {
  add("CF_DOMAIN", "Phải là hostname thuần, không có scheme/path/port.", "Nhập domain đã active trong Cloudflare.", "github-mcp.example.com");
}
if (mcpToken.length < 24 || /\s/.test(mcpToken)) {
  add("MCP_TOKEN", "Token bắt buộc, tối thiểu 24 ký tự và không có whitespace.", "Tạo token ngẫu nhiên dài ít nhất 32 bytes.", "mcp_live_<random-secret>");
} else if (mcpToken.length < 32) {
  warnings.push("MCP_TOKEN is shorter than the recommended 32 characters.");
}
if (env.MCP_OAUTH_CLIENT_ID && !/^[A-Za-z0-9._-]{8,128}$/.test(env.MCP_OAUTH_CLIENT_ID)) {
  add("MCP_OAUTH_CLIENT_ID", "Client ID sai định dạng.", "Dùng 8-128 ký tự chữ/số/._-.", "github-mcp-proxy-client");
}
if (env.MCP_OAUTH_CLIENT_ID && (!env.MCP_OAUTH_CLIENT_SECRET || env.MCP_OAUTH_CLIENT_SECRET.length < 24 || /\s/.test(env.MCP_OAUTH_CLIENT_SECRET))) {
  add("MCP_OAUTH_CLIENT_SECRET", "Khi có client ID, secret phải dài ít nhất 24 ký tự.", "Tạo client secret mới.", "<OAuth client secret>");
}

let mode = "";
let serviceAccount = null;
try {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim()) {
    const encoded = env.FIREBASE_SERVICE_ACCOUNT_JSON_B64.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Base64 có ký tự không hợp lệ");
    serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    mode = "service_account_b64";
  } else if (env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    mode = "service_account_json";
  }
  if (serviceAccount && (serviceAccount.type !== "service_account" || !String(serviceAccount.client_email).includes("@") || !String(serviceAccount.private_key).includes("BEGIN PRIVATE KEY"))) {
    throw new Error("JSON không phải Service Account đầy đủ");
  }
} catch (error) {
  add(
    env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim() ? "FIREBASE_SERVICE_ACCOUNT_JSON_B64" : "FIREBASE_SERVICE_ACCOUNT_JSON",
    (error instanceof Error ? error.message : "Invalid Service Account JSON") + "; giá trị bí mật không được in ra log.",
    "Tạo lại Base64 một dòng từ Service Account JSON.",
    "Linux: base64 -w 0 service-account.json | macOS: base64 -i service-account.json | tr -d '\\n' | PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes('service-account.json'))"
  );
}

function normalizeRtdbUrl(raw, removeAuth = false) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !(/\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname))) {
    throw new Error("RTDB URL must use HTTPS and a Firebase database hostname");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/github_accounts.json";
  else if (url.pathname === "/github_accounts") url.pathname += ".json";
  else if (!url.pathname.endsWith(".json")) throw new Error("RTDB URL path must point to github_accounts.json");
  if (removeAuth) url.searchParams.delete("auth");
  return url.toString();
}

let rtdbUrl = serviceAccount
  ? (env.RTDB_URL?.trim() || env.RTDB_AUTH_URL?.trim() || "")
  : (env.RTDB_AUTH_URL?.trim() || "");
try {
  if (!rtdbUrl) throw new Error("No RTDB URL supplied");
  rtdbUrl = normalizeRtdbUrl(rtdbUrl, Boolean(serviceAccount));
  if (!serviceAccount && !new URL(rtdbUrl).searchParams.get("auth")) {
    throw new Error("Fallback URL must include ?auth= when Service Account is not configured");
  }
} catch (error) {
  add(
    "RTDB_URL / RTDB_AUTH_URL",
    error instanceof Error ? error.message : "Invalid RTDB URL",
    "Use a Firebase database URL. A database root URL or /github_accounts is normalized to /github_accounts.json; fallback RTDB_AUTH_URL must also include ?auth=.",
    "https://project-default-rtdb.asia-southeast1.firebasedatabase.app/github_accounts.json"
  );
}
if (!serviceAccount && !env.RTDB_AUTH_URL?.trim()) {
  add("Firebase RTDB authentication", "Thiếu Service Account và RTDB_AUTH_URL fallback.", "Thêm FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL hoặc RTDB_AUTH_URL có ?auth=.", "FIREBASE_SERVICE_ACCOUNT_JSON_B64 + RTDB_URL");
}

if (errors.length) {
  console.error("[PRE-FLIGHT CHECK FAILED] " + errors.length + " lỗi cấu hình:");
  errors.forEach((error, index) => {
    console.error((index + 1) + ". " + error.name + "\n   Nguyên nhân: " + error.reason + "\n   Cách sửa: " + error.fix + "\n   Ví dụ: " + error.example);
  });
  process.exit(1);
}

function describeRtdbValue(value) {
  if (value === null) return "null (node does not exist or is empty)";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  const first = Object.values(value)[0];
  const fields = first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first) : [];
  return "object with " + keys.length + " top-level entries; first-entry fields=[" + fields.slice(0, 20).join(",") + "]";
}
async function nodeChildNames(url, nodePath, accessToken) {
  try {
    const root = new URL(url);
    root.pathname = nodePath === "/" ? "/.json" : nodePath.replace(/\/+$/, "") + ".json";
    root.searchParams.set("shallow", "true");
    if (accessToken) root.searchParams.set("access_token", accessToken);
    const response = await fetch(root);
    if (!response.ok) return "unavailable";
    const value = await response.json();
    return value && typeof value === "object" ? Object.keys(value).slice(0, 30).join(",") || "(empty)" : "(empty)";
  } catch {
    return "unavailable";
  }
}
async function cloudflare(path) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { "X-Auth-Email": email, "X-Auth-Key": apiKey }
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error("Cloudflare API validation failed (HTTP " + response.status + ")");
  return data.result;
}

let enabledAccounts = 0;
try {
  const user = await cloudflare("/user");
  if (!user) throw new Error("Cloudflare credentials rejected");
  const zones = await cloudflare("/zones?per_page=50");
  const zone = zones
    .filter(item => item.status === "active" && (domain === item.name || domain.endsWith("." + item.name)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw new Error("No active Cloudflare zone matches CF_DOMAIN");
  const dns = await cloudflare("/zones/" + zone.id + "/dns_records?name=" + encodeURIComponent(domain));
  if (dns.some(record => ["A", "AAAA", "CNAME"].includes(record.type))) {
    warnings.push("DNS records already exist for CF_DOMAIN; verify compatibility before custom-domain attach.");
  }

  if (serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
      aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    });
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = unsigned + "." + signer.sign(String(serviceAccount.private_key).replace(/\\n/g, "\n"), "base64url");
    const tokenResponse = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    if (!tokenResponse.ok) throw new Error("Firebase Service Account OAuth validation failed (HTTP " + tokenResponse.status + ")");
    const tokenData = await tokenResponse.json();
    const url = new URL(rtdbUrl);
    url.searchParams.set("access_token", tokenData.access_token);
    const response = await fetch(url);
    if (!response.ok) throw new Error("RTDB live check failed (HTTP " + response.status + ")");
    const data = await response.json();
    if (!data || typeof data !== "object" || !Object.values(data).some(account => account?.token && account.enabled !== false)) {
      const rootKeys = await nodeChildNames(rtdbUrl, "/", tokenData.access_token);
      const envKeys = rootKeys.split(",").includes("env") ? await nodeChildNames(rtdbUrl, "/env", tokenData.access_token) : "not-present";
      throw new Error("RTDB account node has no enabled direct account records (" + describeRtdbValue(data) + "). Database root child names: [" + rootKeys + "]; /env child names: [" + envKeys + "]. Expected /github_accounts or /env/github_accounts with child records containing token and enabled fields.");
    }
    enabledAccounts = Object.values(data).filter(account => account?.token && account.enabled !== false).length;
  } else {
    const response = await fetch(rtdbUrl);
    if (!response.ok) throw new Error("RTDB fallback live check failed (HTTP " + response.status + ")");
    const data = await response.json();
    if (!data || typeof data !== "object" || !Object.values(data).some(account => account?.token && account.enabled !== false)) {
      const rootKeys = await nodeChildNames(rtdbUrl, "/");
      const envKeys = rootKeys.split(",").includes("env") ? await nodeChildNames(rtdbUrl, "/env") : "not-present";
      throw new Error("RTDB account node has no enabled direct account records (" + describeRtdbValue(data) + "). Database root child names: [" + rootKeys + "]; /env child names: [" + envKeys + "]. Expected /github_accounts or /env/github_accounts with child records containing token and enabled fields.");
    }
    enabledAccounts = Object.values(data).filter(account => account?.token && account.enabled !== false).length;
  }

  console.log("[PRE-FLIGHT CHECK PASSED] Cloudflare zone verified; RTDB mode=" + (mode || "legacy_auth_fallback") + "; enabled accounts=" + enabledAccounts + ". Secrets were not printed.");
  warnings.forEach(warning => console.warn("WARNING: " + warning));
} catch (error) {
  console.error("[PRE-FLIGHT CHECK FAILED] " + (error instanceof Error ? error.message : "Live check failed") + "; credentials and RTDB values were redacted.");
  process.exit(1);
}