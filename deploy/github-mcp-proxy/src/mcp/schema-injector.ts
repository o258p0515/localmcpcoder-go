import type { McpTool } from "../types";
export function injectAccountParameter(tool:McpTool):McpTool {
 const out=structuredClone(tool), schema=out.inputSchema??{type:"object",properties:{},required:[]};
 schema.type=schema.type||"object";schema.properties={...(schema.properties||{}),account:{type:"string",description:"REQUIRED. GitHub account alias. Call list_github_accounts first; never guess."}};
 schema.required=[...new Set([...(schema.required||[]),"account"])];out.inputSchema=schema;
 const note="[Multi-account proxy: requires 'account' alias from list_github_accounts]";
 if(!String(out.description||"").includes(note))out.description=[out.description,note].filter(Boolean).join("\n");
 return out;
}
export function getProxyCustomTools():McpTool[]{return [
 {name:"list_github_accounts",description:"List enabled GitHub accounts and their aliases. Call this before any GitHub tool.",inputSchema:{type:"object",properties:{},required:[]}},
 {name:"refresh_accounts",description:"Clear cached Firebase account data and refresh account and tool catalog caches.",inputSchema:{type:"object",properties:{},required:[]}}
];}