import {readFile,writeFile,appendFile} from "node:fs/promises";
const email=process.env.CF_API_EMAIL,key=process.env.CF_API_KEY,domain=process.env.CF_DOMAIN;
if(!email||!key||!domain)throw new Error("CF_API_EMAIL, CF_API_KEY and CF_DOMAIN are required");
async function cf(path,init={}){const r=await fetch("https://api.cloudflare.com/client/v4"+path,{...init,headers:{"X-Auth-Email":email,"X-Auth-Key":key,"Content-Type":"application/json",...(init.headers||{})}});const d=await r.json();if(!r.ok||!d.success)throw new Error("Cloudflare API failed for "+path+" (HTTP "+r.status+"): "+(d.errors||[]).map(x=>x.message).join("; "));return d.result;}
const zones=await cf("/zones?per_page=50"),zone=zones.filter(z=>z.status==="active"&&(domain===z.name||domain.endsWith("."+z.name))).sort((a,b)=>b.name.length-a.name.length)[0];
if(!zone)throw new Error("No active Cloudflare zone found for CF_DOMAIN");
const namespaces=await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces?per_page=100");
async function ensure(title){const found=namespaces.find(x=>x.title===title);if(found)return found.id;return (await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces",{method:"POST",body:JSON.stringify({title})})).id;}
const oauth=await ensure("github-mcp-oauth-kv"),cache=await ensure("github-mcp-cache-kv");
let cfg=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
cfg=cfg.replaceAll("__CF_ACCOUNT_ID__",zone.account.id).replaceAll("__CF_DOMAIN__",domain).replaceAll("__OAUTH_KV_ID__",oauth).replaceAll("__CACHE_KV_ID__",cache);
await writeFile(new URL("../wrangler.deploy.jsonc",import.meta.url),cfg);
if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,"CLOUDFLARE_ACCOUNT_ID="+zone.account.id+"\nCLOUDFLARE_API_KEY="+key+"\nCLOUDFLARE_EMAIL="+email+"\n");
console.error("Prepared Cloudflare deployment config; account and credentials are not printed.");