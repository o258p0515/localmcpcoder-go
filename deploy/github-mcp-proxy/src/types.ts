export interface RtdbAccount {
  username: string; token: string; description: string; orgs: string[];
  enabled: boolean; readonly: boolean; is_catalog_source?: boolean;
}
export interface Env {
  MCP_TOKEN: string; MCP_OAUTH_CLIENT_ID?: string; MCP_OAUTH_CLIENT_SECRET?: string;
  RTDB_URL?: string; RTDB_AUTH_URL?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON_B64?: string; FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  PUBLIC_ORIGIN: string; GITHUB_MCP_UPSTREAM_URL?: string; GITHUB_MCP_TOOLSETS?: string;
  RTDB_CACHE_TTL_SECONDS?: string; OAUTH_KV: KVNamespace; CACHE_KV: KVNamespace;
  SSE_SESSIONS: DurableObjectNamespace;
}
export interface AuthContext { authenticated?: boolean; method: "static_token" | "oauth"; subject: string; pinnedAccount?: string; sessionId?: string }
export interface McpTool { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[]; [key:string]: unknown }; [key:string]: unknown }
export interface JsonRpc { jsonrpc: "2.0"; id?: string|number|null; method: string; params?: any }