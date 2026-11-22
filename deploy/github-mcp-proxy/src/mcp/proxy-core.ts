import type { Env,AuthContext,JsonRpc,McpTool } from "../types";
import { getAccounts,listPublicAccounts,resolveAccount,clearAccountCaches } from "../rtdb/account-store";
import { callUpstream,clearUpstreamSessions } from "./upstream-client";
import { getProxyCustomTools,injectAccountParameter } from "./schema-injector";
import { auditLog } from "../utils/logger";
const INSTRUCTIONS="You are connected to a multi-account GitHub MCP Proxy. Before any GitHub tool, call list_github_accounts (or read github://accounts), select the exact alias and pass it in account on every call. Invalid or missing aliases are rejected; no fallback is performed. After RTDB changes call refresh_accounts.";
function result(id:any,value:any){return {jsonrpc:"2.0",id,result:value};}
function error(id:any,code:number,message:string){return {jsonrpc:"2.0",id,error:{code,message}};}
function textResult(value:any,isError=false){return {content:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value,null,2)}],...(isError?{isError:true}:{})};}
async function createRepositoryWithRest(account:import("../types").RtdbAccount,args:Record<string,any>){
 const name=String(args.name||"").trim();
 if(!name)return textResult("create_repository requires a non-empty name.",true);
 const organization=typeof args.organization==="string"?args.organization.trim():"";
 const endpoint=organization?"https://api.github.com/orgs/"+encodeURIComponent(organization)+"/repos":"https://api.github.com/user/repos";
 const apiHeaders={Authorization:"Bearer "+account.token,Accept:"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"localmcpcoder-github-mcp-proxy"};
 let identityResponse:Response|null=null,identity:any={};
 try{identityResponse=await fetch("https://api.github.com/user",{headers:apiHeaders});const identityRaw=await identityResponse.text();try{identity=identityRaw?JSON.parse(identityRaw):{};}catch{identity={};}}catch{identityResponse=null;}
 const tokenType=account.token.startsWith("github_pat_")?"fine-grained PAT":account.token.startsWith("ghp_")?"classic PAT":account.token.startsWith("ghu_")?"GitHub App user token":account.token.startsWith("ghs_")?"GitHub App installation token":account.token.startsWith("gho_")?"OAuth token":account.token.startsWith("ghr_")?"refresh token":"unknown";
 const payload={name,description:typeof args.description==="string"?args.description:undefined,private:args.private===true,auto_init:args.autoInit===true};
 const response=await fetch(endpoint,{method:"POST",headers:apiHeaders,body:JSON.stringify(payload)});
 const raw=await response.text();let data:any;try{data=raw?JSON.parse(raw):{};}catch{data={message:raw.slice(0,1000)};}
 if(!response.ok){
  const required=response.headers.get("X-Accepted-GitHub-Permissions");
  const requestId=response.headers.get("X-GitHub-Request-Id");
  return textResult({error:"GitHub repository creation failed",status:response.status,message:data?.message||"Unknown GitHub API error",errors:data?.errors||undefined,required_permissions:required||undefined,request_id:requestId||undefined,endpoint,authentication:{identity_status:identityResponse?.status??null,login:identity?.login||null,token_type:tokenType,oauth_scopes:identityResponse?.headers.get("X-OAuth-Scopes")||null,accepted_permissions:identityResponse?.headers.get("X-Accepted-GitHub-Permissions")||null}},true);
 }
 return textResult({message:"Repository created successfully",repository:{id:data.id,full_name:data.full_name,html_url:data.html_url,private:data.private,default_branch:data.default_branch}});
}
export async function handleJsonRpcMessage(msg:JsonRpc,env:Env,ctx:AuthContext):Promise<any|null>{
 if(!msg||msg.jsonrpc!=="2.0"||typeof msg.method!=="string")return error(msg?.id??null,-32600,"Invalid JSON-RPC request");
 if(!("id" in msg))return null;
 const p=msg.params||{};
 try{
  if(msg.method==="ping")return result(msg.id,{});
  if(msg.method==="initialize")return result(msg.id,{protocolVersion:"2025-03-26",serverInfo:{name:"github-mcp-proxy",version:"1.0.0"},capabilities:{tools:{listChanged:true},resources:{subscribe:false,listChanged:false}},instructions:INSTRUCTIONS});
  if(msg.method==="resources/list")return result(msg.id,{resources:[{uri:"github://accounts",name:"GitHub Accounts Directory",description:"Enabled GitHub account aliases and metadata (never tokens)",mimeType:"application/json"}]});
  if(msg.method==="resources/read"){if(p.uri!=="github://accounts")return error(msg.id,-32602,"Unknown resource");return result(msg.id,{contents:[{uri:p.uri,mimeType:"application/json",text:JSON.stringify(await listPublicAccounts(env))}]});}
  if(msg.method==="tools/list"){
   let tools:McpTool[]=[];const cached=await env.CACHE_KV.get("mcp:tools_catalog:v1");
   if(cached){try{tools=JSON.parse(cached);}catch{}}
   if(!tools.length){const accounts=await getAccounts(env);const source=Object.entries(accounts).find(([,a])=>a.enabled&&a.is_catalog_source)||Object.entries(accounts).find(([,a])=>a.enabled);if(!source)throw Error("No enabled GitHub account available");const upstream=await callUpstream(env,source[1],source[0],{jsonrpc:"2.0",id:"catalog",method:"tools/list",params:{}});tools=(upstream?.result?.tools||[]).map(injectAccountParameter);await env.CACHE_KV.put("mcp:tools_catalog:v1",JSON.stringify(tools),{expirationTtl:300});}
   return result(msg.id,{tools:[...getProxyCustomTools(),...tools]});
  }
  if(msg.method==="tools/call"){
   const name=String(p.name||""),args={...(p.arguments||{})};
   if(name==="list_github_accounts")return result(msg.id,textResult(await listPublicAccounts(env)));
   if(name==="refresh_accounts"){await clearAccountCaches(env);clearUpstreamSessions();const a=await listPublicAccounts(env);return result(msg.id,textResult({message:"Account and tool catalog caches refreshed",accounts:a}));}
   const alias=String(args.account||ctx.pinnedAccount||"");const resolved=await resolveAccount(env,alias);
   if(!resolved.ok){const available=resolved.availableAccounts.map(a=>"- "+a.alias+" (username: "+a.username+", readonly: "+a.readonly+", orgs: ["+a.orgs.join(", ")+"]): "+a.description).join("\n");return result(msg.id,textResult("Invalid or missing 'account' parameter (received: "+JSON.stringify(alias)+"). This proxy does NOT auto-fallback. Retry with a valid alias:\n"+available,true));}
   const account=resolved.account;
   const writeTool=/(?:^|_)(?:write|create|update|delete|push|merge|add|remove|fork|dismiss|submit|request|close|reopen|assign|cancel|rerun|enable|disable|set|put|patch)(?:_|$)/i;
   // This tool starts a repository security scan even though its name does not
   // contain a conventional write verb. Treat it as mutating for read-only accounts.
   const explicitlyMutatingTools=new Set(["run_secret_scanning"]);
   if(account.readonly&&(writeTool.test(name)||explicitlyMutatingTools.has(name)))return result(msg.id,textResult("Account '"+alias+"' is read-only; this write operation is blocked.",true));
   delete args.account;const start=Date.now();let status="ok";
   try{
    if(name==="create_repository"){
     const value=await createRepositoryWithRest(account,args);
     auditLog({event:"tool_call",tool:name,account:alias,authMethod:ctx.method,durationMs:Date.now()-start,status:value.isError?"error":"ok"});
     return result(msg.id,value);
    }
    const out=await callUpstream(env,account,alias,{jsonrpc:"2.0",id:msg.id,method:"tools/call",params:{name,arguments:args}});
    auditLog({event:"tool_call",tool:name,account:alias,authMethod:ctx.method,durationMs:Date.now()-start,status:out?.result?.isError||out?.error?"error":"ok"});
    return out;
   }catch(e){status="error";auditLog({event:"tool_call",tool:name,account:alias,authMethod:ctx.method,durationMs:Date.now()-start,status});throw e;}
  }
  return error(msg.id,-32601,"Method not found: "+msg.method);
 }catch(e){return error(msg.id,-32000,e instanceof Error?e.message:"Internal error");}
}
export async function handleJsonRpcBatch(msgs:JsonRpc[],env:Env,ctx:AuthContext){const out=await Promise.all(msgs.map(m=>handleJsonRpcMessage(m,env,ctx)));return out.filter(Boolean);}