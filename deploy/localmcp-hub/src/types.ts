export interface Env {
  MCP_TOKEN: string;
  ADMIN_TOKEN: string;
  MCP_OAUTH_CLIENT_ID?: string;
  MCP_OAUTH_CLIENT_SECRET?: string;
  MCP_OAUTH_REDIRECT_URIS?: string;
  REGISTRY_DO: DurableObjectNamespace;
  RUNNER_DO: DurableObjectNamespace;
}
export interface RunnerInfo {
  runner_id: string;
  os: string;
  arch: string;
  repo: string;
  tags: string[];
  status: "online" | "draining";
  connected_at: number;
}
export interface RpcEnvelope {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}
