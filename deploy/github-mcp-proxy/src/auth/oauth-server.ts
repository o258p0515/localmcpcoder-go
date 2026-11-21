import type { Env } from "../types";
import { base64UrlDecode,base64UrlEncode,randomToken,sha256Base64Url,sha256Hex,timingSafeEqual } from "../utils/crypto";
type Client={client_id:string;client_secret?:string;client_secret_hash?:string;client_name:string;token_endpoint_auth_method:string};
const json=(v:any,s=200)=>Response.json(v,{status:s,headers:{"Cache-Control":"no-store"}});
const form=(r:Request)=>r.headers.get("content-type")?.includes("application/json")?r.json():r.formData().then(f=>Object.fromEntries(f.entries()));
export function isValidRedirectUri(raw:string):boolean{try{const u=new URL(raw);return !u.hash&&!["javascript:","data:","vbscript:"].includes(u.protocol.toLowerCase())&&!!u.protocol;}catch{return false;}}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
async function client(env:Env,id:string):Promise<Client|null>{
 if(env.MCP_OAUTH_CLIENT_ID&&timingSafeEqual(id,env.MCP_OAUTH_CLIENT_ID))return {client_id:id,client_name:"Configured MCP client",client_secret:env.MCP_OAUTH_CLIENT_SECRET,token_endpoint_auth_method:env.MCP_OAUTH_CLIENT_SECRET?"client_secret_basic":"none"};
 for(let attempt=0;attempt<3;attempt++){const raw=await env.OAUTH_KV.get("oauth:dcr:"+id);if(raw)return JSON.parse(raw);if(attempt<2)await new Promise(resolve=>setTimeout(resolve,300));}return null;
}
async function issueTokens(env:Env,clientId:string){const at="mcp_at_"+randomToken(32),rt="mcp_rt_"+randomToken(32);await env.OAUTH_KV.put("oauth:access:"+await sha256Hex(at),JSON.stringify({clientId,exp:Date.now()+86400000}),{expirationTtl:86400});await env.OAUTH_KV.put("oauth:refresh:"+await sha256Hex(rt),JSON.stringify({clientId,exp:Date.now()+2592000000}),{expirationTtl:2592000});return {access_token:at,token_type:"Bearer",expires_in:86400,refresh_token:rt,scope:"mcp:tools"};}
export async function handleOAuthRequest(req:Request,env:Env):Promise<Response>{
 const u=new URL(req.url),path=u.pathname;
 if(path==="/register"&&req.method==="POST"){
  const b:any=await req.json();const uris=Array.isArray(b.redirect_uris)?b.redirect_uris:[];
  if(uris.some((x:any)=>typeof x!=="string"||!isValidRedirectUri(x)))return json({error:"invalid_redirect_uri"},400);
  const id="dcr_"+randomToken(16),method=b.token_endpoint_auth_method||"none";if(!["none","client_secret_basic","client_secret_post"].includes(method))return json({error:"invalid_client_metadata"},400);const secret=method==="none"?undefined:randomToken(32);
  const c:Client={client_id:id,client_name:String(b.client_name||"Dynamic MCP client"),token_endpoint_auth_method:method,...(secret?{client_secret:secret}:{})};
  const stored:Client={...c,client_secret:undefined,...(secret?{client_secret_hash:await sha256Hex(secret)}:{})};await env.OAUTH_KV.put("oauth:dcr:"+id,JSON.stringify(stored),{expirationTtl:7776000});
  return json({...c,redirect_uris:uris,grant_types:["authorization_code","refresh_token"],response_types:["code"],...(secret?{client_secret:secret}:{})},201);
 }
 if(path==="/authorize"&&req.method==="GET"){
  const p=u.searchParams,redirect=p.get("redirect_uri")||"",cid=p.get("client_id")||"",c=await client(env,cid);
  if(p.get("response_type")!=="code"||!c||!isValidRedirectUri(redirect)||!p.get("code_challenge")||p.get("code_challenge_method")!=="S256")return new Response("Invalid OAuth authorization request (PKCE S256 is required)",{status:400});
  const csrf=randomToken(24),html='<!doctype html><meta charset="utf-8"><title>Authorize GitHub MCP Proxy</title><h1>Authorize '+esc(c.client_name)+'</h1><p>Redirect destination: <code>'+esc(redirect)+'</code></p><form method="post" action="/authorize"><input type="hidden" name="csrf" value="'+csrf+'"><input type="hidden" name="client_id" value="'+esc(cid)+'"><input type="hidden" name="redirect_uri" value="'+esc(redirect)+'"><input type="hidden" name="state" value="'+esc(p.get("state")||"")+'"><input type="hidden" name="code_challenge" value="'+esc(p.get("code_challenge")||"")+'"><input type="hidden" name="code_challenge_method" value="'+esc(p.get("code_challenge_method")||"")+'"><label>Enter MCP_TOKEN <input type="password" name="approval_token" required></label><button>Approve</button></form>';
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Set-Cookie":"mcp_oauth_csrf="+csrf+"; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=600"}});
 }
 if(path==="/authorize"&&req.method==="POST"){
  const b:any=await form(req),cookie=req.headers.get("Cookie")||"",m=/mcp_oauth_csrf=([^;]+)/.exec(cookie);
  if(!m||!timingSafeEqual(m[1]||"",String(b.csrf||""))||!timingSafeEqual(String(b.approval_token||""),env.MCP_TOKEN))return new Response("Authorization denied: invalid CSRF or approval token",{status:403});
  const c=await client(env,String(b.client_id||"")),redirect=String(b.redirect_uri||"");if(!c||!isValidRedirectUri(redirect)||!String(b.code_challenge||"")||b.code_challenge_method!=="S256")return new Response("Invalid OAuth client, redirect URI, or missing PKCE S256",{status:400});
  const code=randomToken(32);await env.OAUTH_KV.put("oauth:code:"+await sha256Hex(code),JSON.stringify({clientId:c.client_id,redirectUri:redirect,challenge:String(b.code_challenge||""),method:String(b.code_challenge_method||""),exp:Date.now()+300000}),{expirationTtl:300});
  const target=new URL(redirect);target.searchParams.set("code",code);if(b.state)target.searchParams.set("state",String(b.state));
  return Response.redirect(target.toString(),302);
 }
 if(path==="/token"&&req.method==="POST"){
  const b:any=await form(req);let cid=String(b.client_id||""),secret=String(b.client_secret||"");
  const basic=req.headers.get("Authorization")?.match(/^Basic (.+)$/i)?.[1];if(basic){try{const pair=atob(basic);const i=pair.indexOf(":");cid=pair.slice(0,i);secret=pair.slice(i+1);}catch{return json({error:"invalid_client"},401);}}
  const c=await client(env,cid);if(!c)return json({error:"invalid_client"},401);
  if(c.client_secret_hash&&!timingSafeEqual(await sha256Hex(secret),c.client_secret_hash))return json({error:"invalid_client"},401);if(c.client_secret&&!timingSafeEqual(secret,c.client_secret))return json({error:"invalid_client"},401);
  if(b.grant_type==="authorization_code"){
   const key="oauth:code:"+await sha256Hex(String(b.code||"")),raw=await env.OAUTH_KV.get(key);await env.OAUTH_KV.delete(key);if(!raw)return json({error:"invalid_grant"},400);
   const v=JSON.parse(raw);if(v.clientId!==cid||(b.redirect_uri&&b.redirect_uri!==v.redirectUri))return json({error:"invalid_grant"},400);
   if(v.challenge){if(v.method!=="S256"||await sha256Base64Url(String(b.code_verifier||""))!==v.challenge)return json({error:"invalid_grant"},400);}
   return json(await issueTokens(env,cid));
  }
  if(b.grant_type==="refresh_token"){
   const key="oauth:refresh:"+await sha256Hex(String(b.refresh_token||"")),raw=await env.OAUTH_KV.get(key);await env.OAUTH_KV.delete(key);if(!raw)return json({error:"invalid_grant"},400);
   const v=JSON.parse(raw);if(v.clientId!==cid)return json({error:"invalid_grant"},400);return json(await issueTokens(env,cid));
  }
  return json({error:"unsupported_grant_type"},400);
 }
 return new Response("Method Not Allowed",{status:405});
}