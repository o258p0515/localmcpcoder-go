import {describe,it,expect,vi,beforeEach,afterEach} from "vitest";
import {getAccounts,listPublicAccounts,resolveAccount,clearAccountCaches} from "../src/rtdb/account-store";
function makeKV(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>{m.set(k,v);},delete:async(k:string)=>m.delete(k)} as any;}
function env(data:any){return {MCP_TOKEN:"unit-test-secret",RTDB_AUTH_URL:"https://unit.firebaseio.com/github_accounts.json?auth=unit-auth",CACHE_KV:makeKV(),OAUTH_KV:makeKV(),...data} as any;}
describe("Firebase account store",()=>{
 beforeEach(()=>vi.stubGlobal("fetch",vi.fn(async()=>Response.json({personal:{username:"me",token:"ghp_never-leak",enabled:true,orgs:["org"]},disabled:{username:"off",token:"ghp_disabled",enabled:false}}))));
 afterEach(()=>vi.unstubAllGlobals());
 it("loads legacy RTDB auth and encrypts cached PATs",async()=>{const e=env({});const a=await getAccounts(e);expect(a["personal"]!.token).toBe("ghp_never-leak");const cached=e.CACHE_KV.m.get("rtdb:accounts:v1");expect(cached).toBeTruthy();expect(cached).not.toContain("ghp_never-leak");const pub=await listPublicAccounts(e);expect(pub).toHaveLength(1);expect(pub[0]).not.toHaveProperty("token");});
 it("never falls back to another account for a bad alias",async()=>{const e=env({});const r=await resolveAccount(e,"does-not-exist");expect(r.ok).toBe(false);if(!r.ok)expect(r.availableAccounts.map(x=>x.alias)).toEqual(["personal"]);});
 it("clears both account and tool catalogue caches",async()=>{const e=env({});await getAccounts(e);await e.CACHE_KV.put("mcp:tools_catalog:v1","[]");await clearAccountCaches(e);expect(e.CACHE_KV.m.has("rtdb:accounts:v1")).toBe(false);expect(e.CACHE_KV.m.has("mcp:tools_catalog:v1")).toBe(false);});
});
 it("uses Base64 Service Account before raw JSON and authenticates RTDB with OAuth",async()=>{
  const pair=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const der=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey));let binary="";for(const b of der)binary+=String.fromCharCode(b);
  const privateKey="-----BEGIN PRIVATE KEY-----\\n"+btoa(binary).match(/.{1,64}/g)!.join("\\n")+"\\n-----END PRIVATE KEY-----";
  const good={type:"service_account",client_email:"worker@example.iam.gserviceaccount.com",private_key:privateKey,token_uri:"https://oauth2.googleapis.com/token"};
  const bad={type:"invalid"};
  const calls:any[]=[];vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{const url=String(input);calls.push({url,init});if(url.includes("oauth2.googleapis.com/token"))return Response.json({access_token:"google-access",expires_in:3600});return Response.json({personal:{username:"me",token:"ghp_pat",enabled:true}});}));
  const e=env({FIREBASE_SERVICE_ACCOUNT_JSON_B64:btoa(JSON.stringify(good)),FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(bad),RTDB_URL:"https://unit.firebaseio.com/github_accounts.json",RTDB_AUTH_URL:""});
  const accounts=await getAccounts(e);expect(accounts.personal?.token).toBe("ghp_pat");
  const rtdb=calls.find(x=>x.url.includes("github_accounts.json"));expect(rtdb.init.headers.get("Authorization")).toBe("Bearer google-access");expect(rtdb.url).not.toContain("auth=");
 });