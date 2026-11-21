import type { Env } from "../types";
import { decodeBase64Utf8, encryptAesGcm, decryptAesGcm } from "../utils/crypto";
export function resolveServiceAccountFromEnv(env:Env):{json:string;mode:"service_account_b64"|"service_account_json"}|null {
 if(env.FIREBASE_SERVICE_ACCOUNT_JSON_B64?.trim())return {json:decodeBase64Utf8(env.FIREBASE_SERVICE_ACCOUNT_JSON_B64),mode:"service_account_b64"};
 if(env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim())return {json:env.FIREBASE_SERVICE_ACCOUNT_JSON.trim(),mode:"service_account_json"};
 return null;
}
function b64url(s:string){return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");}
export async function googleAccessToken(env:Env):Promise<string>{
 const cached=await env.CACHE_KV.get("rtdb:google_oauth_token:v1");
 if(cached){try{const v=JSON.parse(await decryptAesGcm(cached,env.MCP_TOKEN));if(v.exp>Date.now()+60000)return v.token;}catch{}}
 const sa=resolveServiceAccountFromEnv(env);if(!sa)throw Error("Firebase service account is not configured");
 const p=JSON.parse(sa.json);if(p.type!=="service_account"||!p.client_email||!p.private_key)throw Error("Invalid Firebase service account");
 const now=Math.floor(Date.now()/1000),header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
 const payload=b64url(JSON.stringify({iss:p.client_email,scope:"https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",aud:p.token_uri||"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
 const unsigned=header+"."+payload, pem=String(p.private_key).replace(/\\n/g,"\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
 const der=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey("pkcs8",der,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
 const sig=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned));
 const assertion=unsigned+"."+b64url(String.fromCharCode(...new Uint8Array(sig)));
 const res=await fetch(p.token_uri||"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
 if(!res.ok)throw Error("Google OAuth token exchange failed (HTTP "+res.status+")");
 const data:any=await res.json();if(!data.access_token)throw Error("Google OAuth response missing access_token");
 await env.CACHE_KV.put("rtdb:google_oauth_token:v1",await encryptAesGcm(JSON.stringify({token:data.access_token,exp:Date.now()+Math.max(60,data.expires_in||3600)*1000}),env.MCP_TOKEN),{expirationTtl:3000});
 return data.access_token;
}