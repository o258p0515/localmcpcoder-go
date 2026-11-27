export interface Env {
  MCP_TOKEN: string;
  ADMIN_TOKEN: string;
  MCP_OAUTH_CLIENT_ID?: string;
  MCP_OAUTH_CLIENT_SECRET?: string;
  MCP_OAUTH_REDIRECT_URIS?: string;
  HANDOVER_WEBHOOK_URL?: string;
  HANDOVER_WEBHOOK_TOKEN?: string;
  HANDOVER_MAX_GENERATIONS?: string;
  REGISTRY_DO: DurableObjectNamespace;
  RUNNER_DO: DurableObjectNamespace;
}
export type HandoverState = "none" | "requested" | "spawning" | "cutover_done" | "failed";
export interface RunnerInfo {
  runner_id: string;
  os: string;
  arch: string;
  repo: string;
  tags: string[];
  status: "online" | "draining";
  connected_at: number;
  provider?: string;
  account?: string;
  expires_at?: number | null;
  handover_state?: HandoverState;
  predecessor_id?: string | null;
  successor_id?: string | null;
  generation?: number;
}
export interface RpcEnvelope {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}
