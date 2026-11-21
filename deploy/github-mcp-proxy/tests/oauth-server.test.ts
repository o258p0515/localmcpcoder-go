import {describe,it,expect} from "vitest";
import {isValidRedirectUri,handleOAuthRequest} from "../src/auth/oauth-server";
import {sha256Base64Url} from "../src/utils/crypto";
function kv(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>m.set(k,v),delete:async(k:string)=>m.delete(k)} as any;}
describe("OAuth redirect validation and registration",()=>{
 it.each(["https://any.example/callback","http://localhost:8787/cb","cursor://oauth/callback","vscode://callback"])("accepts %s",x=>expect(isValidRedirectUri(x)).toBe(true));
 it.each(["javascript:alert(1)","data:text/html,x","https://host/cb#fragment","not a url"])("rejects %s",x=>expect(isValidRedirectUri(x)).toBe(false));
 it("stores only a hash of a DCR client secret",async()=>{const OAUTH_KV=kv(),env:any={OAUTH_KV};const r=await handleOAuthRequest(new Request("https://proxy/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"test",redirect_uris:["cursor://cb"],token_endpoint_auth_method:"client_secret_post"})}),env);expect(r.status).toBe(201);const data:any=await r.json();const stored=OAUTH_KV.m.get("oauth:dcr:"+data.client_id);expect(stored).not.toContain(data.client_secret);expect(JSON.parse(stored).client_secret_hash).toBeTruthy();});

 it("completes static authorization code + PKCE + refresh rotation",async()=>{
  const OAUTH_KV=kv(),env:any={OAUTH_KV,MCP_TOKEN:"approval-secret",MCP_OAUTH_CLIENT_ID:"github-mcp-client",MCP_OAUTH_CLIENT_SECRET:"oauth-client-secret-long-enough",PUBLIC_ORIGIN:"https://proxy.example"};
  const verifier="verifier-string-with-sufficient-entropy-0123456789",challenge=await sha256Base64Url(verifier);
  const url=new URL("https://proxy.example/authorize");for(const [k,v] of Object.entries({response_type:"code",client_id:env.MCP_OAUTH_CLIENT_ID,redirect_uri:"https://client.example/callback",code_challenge:challenge,code_challenge_method:"S256",state:"state123"}))url.searchParams.set(k,v);
  const get=await handleOAuthRequest(new Request(url),env);expect(get.status).toBe(200);
  const cookie=(get.headers.get("Set-Cookie")||"").split(";")[0],html=await get.text(),csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1]||"";
  const body=new URLSearchParams({csrf,client_id:env.MCP_OAUTH_CLIENT_ID,redirect_uri:"https://client.example/callback",state:"state123",code_challenge:challenge,code_challenge_method:"S256",approval_token:env.MCP_TOKEN});
  const approve=await handleOAuthRequest(new Request("https://proxy.example/authorize",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Cookie:cookie||""},body}),env);
  expect(approve.status).toBe(302);const code=new URL(approve.headers.get("Location")!).searchParams.get("code")!;
  const tokenBody=new URLSearchParams({grant_type:"authorization_code",client_id:env.MCP_OAUTH_CLIENT_ID,client_secret:env.MCP_OAUTH_CLIENT_SECRET,redirect_uri:"https://client.example/callback",code,code_verifier:verifier});
  const tokenResponse=await handleOAuthRequest(new Request("https://proxy.example/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:tokenBody}),env);
  expect(tokenResponse.status).toBe(200);const tokens:any=await tokenResponse.json();expect(tokens.access_token).toMatch(/^mcp_at_/);expect(tokens.refresh_token).toMatch(/^mcp_rt_/);
  const refresh=await handleOAuthRequest(new Request("https://proxy.example/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:env.MCP_OAUTH_CLIENT_ID,client_secret:env.MCP_OAUTH_CLIENT_SECRET,refresh_token:tokens.refresh_token})}),env);
  const rotated:any=await refresh.json();expect(refresh.status).toBe(200);expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
 });
});