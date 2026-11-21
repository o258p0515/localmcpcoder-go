import type { Env,RtdbAccount } from "../types";
const sessions=new Map<string,string>();
const initialized=new Set<string>();
async function request(env:Env,account:RtdbAccount,alias:string,message:any,session?:string):Promise<any>{
 const headers=new Headers({"Authorization":"Bearer "+account.token,"Content-Type":"application/json","Accept":"application/json, text/event-stream","MCP-Protocol-Version":"2025-03-26"});
 if(account.readonly)headers.set("X-MCP-Readonly","true");
 if(env.GITHUB_MCP_TOOLSETS?.trim())headers.set("X-MCP-Toolsets",env.GITHUB_MCP_TOOLSETS.trim());
 if(session)headers.set("Mcp-Session-Id",session);
 const r=await fetch(env.GITHUB_MCP_UPSTREAM_URL||"https://api.githubcopilot.com/mcp/",{method:"POST",headers,body:JSON.stringify(message)});
 if(r.status===401)throw Error("GitHub token for account '"+alias+"' is invalid or expired (HTTP 401). Update RTDB token and call refresh_accounts.");
 if(r.status===403||r.status===429)throw Error("GitHub upstream rejected account '"+alias+"' (HTTP "+r.status+"): check scopes or rate limit.");
 if(r.status===400||r.status===404)return {error:{code:-32000,message:"Upstream MCP session expired; reinitialize"}};
 const sid=r.headers.get("Mcp-Session-Id");if(sid)sessions.set(alias,sid);
 const ct=r.headers.get("Content-Type")||"";
 if(ct.includes("text/event-stream")){
  const raw=await r.text(),frames=raw.split(/\n\n/).flatMap(x=>{const d=x.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n");if(!d||d==="[DONE]")return[];try{return[JSON.parse(d)]}catch{return[]}});
  return frames.find(x=>x.id===message.id)||frames.at(-1)||{};
 }
 return await r.json().catch(()=>({error:{message:"Invalid upstream JSON response"}}));
}
async function initialize(env:Env,account:RtdbAccount,alias:string):Promise<void>{
 const response=await request(env,account,alias,{jsonrpc:"2.0",id:"proxy-init",method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"github-mcp-proxy",version:"1.0.0"}}});
 if(response?.error)throw Error("GitHub MCP initialize failed for account '"+alias+"': "+(response.error.message||"unknown error"));
 initialized.add(alias);
 const sid=sessions.get(alias);if(sid)await request(env,account,alias,{jsonrpc:"2.0",method:"notifications/initialized",params:{}},sid);
}
export async function callUpstream(env:Env,account:RtdbAccount,alias:string,message:any):Promise<any>{
 if(!initialized.has(alias))await initialize(env,account,alias);
 let sid=sessions.get(alias),res=await request(env,account,alias,message,sid);
 if(res?.error?.code===-32000){
  sessions.delete(alias);initialized.delete(alias);await initialize(env,account,alias);sid=sessions.get(alias);
  res=await request(env,account,alias,message,sid);
 }
 return res;
}

export function clearUpstreamSessions(){sessions.clear();initialized.clear();}