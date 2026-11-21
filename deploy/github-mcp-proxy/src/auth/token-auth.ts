import type { Env,AuthContext } from "../types";
import { timingSafeEqual,sha256Hex } from "../utils/crypto";
export async function authenticateRequest(req:Request,env:Env):Promise<AuthContext|null>{
 const bearer=req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]||"";
 const key=req.headers.get("X-API-Key")||"";
 if((key&&timingSafeEqual(key,env.MCP_TOKEN))||(bearer&&timingSafeEqual(bearer,env.MCP_TOKEN)))return {authenticated:true,method:"static_token",subject:"admin",pinnedAccount:req.headers.get("X-GitHub-Account")||undefined};
 if(bearer){const v=await env.OAUTH_KV.get("oauth:access:"+await sha256Hex(bearer));if(v){const p=JSON.parse(v);if(p.exp>Date.now())return {authenticated:true,method:"oauth",subject:p.clientId,pinnedAccount:req.headers.get("X-GitHub-Account")||undefined};}}
 return null;
}