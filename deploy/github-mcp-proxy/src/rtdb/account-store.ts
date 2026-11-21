import type { Env,RtdbAccount } from "../types";
import { decryptAesGcm,encryptAesGcm } from "../utils/crypto";
import { googleAccessToken,resolveServiceAccountFromEnv } from "./google-jwt";
let memory:{accounts:Record<string,RtdbAccount>;expires:number}|null=null;
function cleanUrl(raw:string){const u=new URL(raw);u.searchParams.delete("auth");return u.toString();}
function normalize(raw:any):Record<string,RtdbAccount>{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("RTDB github_accounts node must be a JSON object");
 const out:Record<string,RtdbAccount>={};for(const [alias,v] of Object.entries(raw)){const a=v as any;if(!a||typeof a.token!=="string"||!a.token.trim())continue;out[alias]={username:String(a.username||""),token:a.token,description:String(a.description||""),orgs:Array.isArray(a.orgs)?a.orgs.map(String):[],enabled:a.enabled!==false,readonly:a.readonly===true,is_catalog_source:a.is_catalog_source===true};}return out;
}
export async function getAccounts(env:Env,options:{forceRefresh?:boolean}={}):Promise<Record<string,RtdbAccount>>{
 const ttl=Math.max(30,Number(env.RTDB_CACHE_TTL_SECONDS)||300);
 if(!options.forceRefresh&&memory&&memory.expires>Date.now())return memory.accounts;
 if(!options.forceRefresh){const c=await env.CACHE_KV.get("rtdb:accounts:v1");if(c){try{const v=JSON.parse(await decryptAesGcm(c,env.MCP_TOKEN));memory={accounts:v,expires:Date.now()+ttl*1000};return v;}catch{}}}
 const sa=resolveServiceAccountFromEnv(env);let url="";
 const headers=new Headers();
 if(sa){url=env.RTDB_URL?.trim()|| (env.RTDB_AUTH_URL?cleanUrl(env.RTDB_AUTH_URL):"");if(!url)throw Error("RTDB_URL or RTDB_AUTH_URL is required with service account");headers.set("Authorization","Bearer "+await googleAccessToken(env));}
 else {url=env.RTDB_AUTH_URL?.trim()||"";if(!url)throw Error("RTDB is not configured: provide Firebase service account + RTDB_URL or RTDB_AUTH_URL");}
 const response=await fetch(url, {headers});if(!response.ok)throw Error("Firebase RTDB request failed (HTTP "+response.status+")");
 const accounts=normalize(await response.json());if(!Object.values(accounts).some(a=>a.enabled))throw Error("Firebase RTDB contains no enabled GitHub account with a token");
 memory={accounts,expires:Date.now()+ttl*1000};
 await env.CACHE_KV.put("rtdb:accounts:v1",await encryptAesGcm(JSON.stringify(accounts),env.MCP_TOKEN),{expirationTtl:ttl});
 return accounts;
}
export async function listPublicAccounts(env:Env){const a=await getAccounts(env);return Object.entries(a).filter(([,v])=>v.enabled).map(([alias,v])=>({alias,username:v.username,description:v.description,orgs:v.orgs,readonly:v.readonly}));}
export async function resolveAccount(env:Env,alias:string){const a=await getAccounts(env);const availableAccounts=Object.entries(a).filter(([,v])=>v.enabled).map(([alias,v])=>({alias,username:v.username,description:v.description,orgs:v.orgs,readonly:v.readonly}));const account=a[alias];return account?.enabled?{ok:true as const,account}:{ok:false as const,reason:"invalid_or_missing",availableAccounts};}
export async function clearAccountCaches(env:Env){memory=null;await Promise.all(["rtdb:accounts:v1","mcp:tools_catalog:v1"].map(k=>env.CACHE_KV.delete(k)));}