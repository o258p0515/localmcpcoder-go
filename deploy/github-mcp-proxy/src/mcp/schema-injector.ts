import type { McpTool } from "../types";

const LEGACY_ACCOUNT_NOTE="[Multi-account proxy: requires 'account' alias from list_github_accounts]";

// Remove the legacy proxy-only field from cached schemas created by older
// deployments. Fresh upstream schemas otherwise pass through unchanged.
export function injectAccountParameter(tool:McpTool):McpTool {
 const out=structuredClone(tool);
 if(String(out.description||"").includes(LEGACY_ACCOUNT_NOTE)){
  const schema=out.inputSchema;
  if(schema?.properties)delete schema.properties.account;
  if(schema?.required)schema.required=schema.required.filter(key=>key!=="account");
  out.description=String(out.description||"").replace(LEGACY_ACCOUNT_NOTE,"").trim();
 }
 return out;
}
export function getProxyCustomTools():McpTool[]{return [
 {name:"list_github_accounts",description:"List enabled GitHub accounts and their aliases. Call this before selecting an account.",inputSchema:{type:"object",properties:{},required:[]}},
 {name:"select_github_account",description:"Select a GitHub account alias for this authenticated MCP session, or authenticated OAuth client when the transport omits a session id. Separate sessions or clients are isolated.",inputSchema:{type:"object",properties:{alias:{type:"string",description:"Exact alias returned by list_github_accounts."}},required:["alias"]}},
 {name:"refresh_accounts",description:"Clear cached Firebase account data and refresh account and tool catalog caches.",inputSchema:{type:"object",properties:{},required:[]}}
];}
