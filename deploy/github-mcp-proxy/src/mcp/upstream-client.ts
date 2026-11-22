import type { Env,RtdbAccount } from "../types";
import { redactSecrets } from "../utils/logger";
const sessions=new Map<string,string>();
const initialized=new Set<string>();
function safeExcerpt(value:string):string{return redactSecrets(value).slice(0,1200);}
function isExpiredSession(status:number,body:string,hadSession:boolean):boolean{
 if(!hadSession)return false;
 if(status===404)return true;
 if(status!==400)return false;
 return /session (?:not found|expired|does not exist)|unknown session|invalid session/i.test(body);
}
async function request(env:Env,account:RtdbAccount,alias:string,message:any,session?:string):Promise<any>{
 const headers=new Headers({"Authorization":"Bearer "+account.token,"Content-Type":"application/json","Accept":"application/json, text/event-stream","MCP-Protocol-Version":"2025-03-26"});
 if(account.readonly)headers.set("X-MCP-Readonly","true");
 if(env.GITHUB_MCP_TOOLSETS?.trim())headers.set("X-MCP-Toolsets",env.GITHUB_MCP_TOOLSETS.trim());
 if(session)headers.set("Mcp-Session-Id",session);
 const r=await fetch(env.GITHUB_MCP_UPSTREAM_URL||"https://api.githubcopilot.com/mcp/",{method:"POST",headers,body:JSON.stringify(message)});
 const sid=r.headers.get("Mcp-Session-Id");if(sid)sessions.set(alias,sid);
 const ct=r.headers.get("Content-Type")||"";
 const raw=await r.text();
 if(!r.ok){
  if(isExpiredSession(r.status,raw,!!session))return {error:{code:-32000,message:"Upstream MCP session expired; reinitialize (HTTP "+r.status+"): "+safeExcerpt(raw.trim())}};
  const details=["GitHub MCP upstream HTTP "+r.status,"account='"+alias+"'", "method='"+String(message.method||"unknown")+"'"];
  const requestId=r.headers.get("X-GitHub-Request-Id");if(requestId)details.push("request_id="+requestId);
  const permissions=r.headers.get("X-Accepted-GitHub-Permissions");if(permissions)details.push("required_permissions="+permissions);
  const excerpt=safeExcerpt(raw.trim());if(excerpt)details.push("body="+excerpt);
  throw Error(details.join("; "));
 }
 if(ct.includes("text/event-stream")){
  const frames=raw.replace(/\r\n/g,"\n").split(/\n\n/).flatMap(x=>{const d=x.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n");if(!d||d==="[DONE]")return[];try{return[JSON.parse(d)]}catch{return[]}});
  return frames.find(x=>x.id===message.id)||frames.at(-1)||{};
 }
 try{return JSON.parse(raw);}catch{return {error:{message:"Invalid upstream JSON response: "+safeExcerpt(raw)}};}
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
