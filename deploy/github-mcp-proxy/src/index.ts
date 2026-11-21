import type { Env } from "./types";
import { authenticateRequest } from "./auth/token-auth";
import { handleStreamableHttp } from "./mcp/streamable-http";
import { SseSessionDO } from "./mcp/sse-session-do";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS","Access-Control-Allow-Headers":"Authorization, Content-Type, Accept, X-API-Key, X-GitHub-Account, Mcp-Session-Id, MCP-Protocol-Version","Access-Control-Expose-Headers":"Mcp-Session-Id"};
function withCors(r:Response){const h=new Headers(r.headers);for(const [k,v] of Object.entries(cors))h.set(k,v);return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});}
export default {async fetch(req:Request,env:Env):Promise<Response>{
 const u=new URL(req.url),path=u.pathname;
 if(req.method==="OPTIONS")return withCors(new Response(null,{status:204}));
 if(req.method==="GET"&&path==="/health")return withCors(Response.json({status:"ok",service:"github-mcp-proxy"}));
 if(path.startsWith("/.well-known/")){
  const origin=env.PUBLIC_ORIGIN;
  if(path.includes("oauth-protected-resource"))return withCors(Response.json({resource:origin,authorization_servers:[origin],bearer_methods_supported:["header"],scopes_supported:["mcp:tools"]}));
  if(path.endsWith("oauth-authorization-server")||path.endsWith("openid-configuration"))return withCors(Response.json({issuer:origin,authorization_endpoint:origin+"/authorize",token_endpoint:origin+"/token",registration_endpoint:origin+"/register",response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none","client_secret_basic","client_secret_post"],scopes_supported:["mcp:tools"]}));
 }
 if(["/register","/authorize","/token"].includes(path)){const {handleOAuthRequest}=await import("./auth/oauth-server");return withCors(await handleOAuthRequest(req,env));}
 if(["/mcp","/sse","/messages"].includes(path)){
  const auth=await authenticateRequest(req,env);
  if(!auth)return withCors(new Response("Unauthorized",{status:401,headers:{"WWW-Authenticate":'Bearer resource_metadata="'+env.PUBLIC_ORIGIN+'/.well-known/oauth-protected-resource"'}}));
  if(path==="/mcp")return withCors(await handleStreamableHttp(req,env,auth));
  const sid=path==="/sse"?crypto.randomUUID():u.searchParams.get("sessionId");
  if(!sid)return withCors(Response.json({error:"sessionId is required"},{status:400}));
  const stub=env.SSE_SESSIONS.get(env.SSE_SESSIONS.idFromName(sid));
  const forwardedHeaders=new Headers(req.headers);forwardedHeaders.set("X-Proxy-Auth-Method",auth.method);forwardedHeaders.set("X-Proxy-Subject",auth.subject);
  const forwarded=new Request(new URL(path+(path==="/sse"?"?sessionId="+sid:u.search),req.url),{method:req.method,headers:forwardedHeaders,body:["GET","HEAD"].includes(req.method)?undefined:req.body,duplex:"half"} as RequestInit);
  const response=await stub.fetch(forwarded);return withCors(response);
 }
 return withCors(new Response("Not Found",{status:404}));
}};
export { SseSessionDO };