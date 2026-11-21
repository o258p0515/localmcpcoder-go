import {readFile,writeFile,appendFile} from "node:fs/promises";
const email=process.env.CF_API_EMAIL,key=process.env.CF_API_KEY,domain=process.env.CF_DOMAIN;
if(!email||!key||!domain)throw new Error("CF_API_EMAIL, CF_API_KEY and CF_DOMAIN are required");
async function cf(path,init={}){const r=await fetch("https://api.cloudflare.com/client/v4"+path,{...init,headers:{"X-Auth-Email":email,"X-Auth-Key":key,"Content-Type":"application/json",...(init.headers||{})}});const d=await r.json();if(!r.ok||!d.success)throw new Error("Cloudflare API failed for "+path+" (HTTP "+r.status+"): "+(d.errors||[]).map(x=>x.message).join("; "));return d.result;}
const zones=await cf("/zones?per_page=50"),zone=zones.filter(z=>z.status==="active"&&(domain===z.name||domain.endsWith("."+z.name))).sort((a,b)=>b.name.length-a.name.length)[0];
if(!zone)throw new Error("No active Cloudflare zone found for CF_DOMAIN");
const subdomainPath="/accounts/"+zone.account.id+"/workers/subdomain";
let workersSubdomain=null;
try {
  workersSubdomain=(await cf(subdomainPath))?.subdomain||null;
} catch(error) {
  if(!String(error).includes("(HTTP 404)"))throw error;
}
if(!workersSubdomain){
  const requested="localmcpcoder-"+zone.account.id.slice(0,6).toLowerCase();
  workersSubdomain=(await cf(subdomainPath,{method:"PUT",body:JSON.stringify({subdomain:requested})}))?.subdomain||requested;
  console.error("Provisioned the required account workers.dev subdomain.");
}else{
  console.error("Reusing the existing account workers.dev subdomain.");
}
async function hasManagedDns(hostname){
  const records=await cf("/zones/"+zone.id+"/dns_records?name="+encodeURIComponent(hostname));
  return records.some(record=>["A","AAAA","CNAME"].includes(record.type));
}
let workerDomain=domain;
if(await hasManagedDns(workerDomain)){
  const candidates=["github-mcp-proxy."+zone.name,"github-mcp-proxy-"+zone.account.id.slice(0,6).toLowerCase()+"."+zone.name];
  const available=[];
  for(const candidate of candidates){if(!await hasManagedDns(candidate)){available.push(candidate);break;}}
  if(!available.length)throw new Error("CF_DOMAIN already has externally managed DNS records and no free proxy hostname was found. Preserve existing DNS; choose an unused hostname in the same Cloudflare zone.");
  workerDomain=available[0];
  console.error("CF_DOMAIN already has DNS records; preserving them and using a separate Worker hostname.");
}
const namespaces=await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces?per_page=100");
async function ensure(title){const found=namespaces.find(x=>x.title===title);if(found)return found.id;return (await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces",{method:"POST",body:JSON.stringify({title})})).id;}
const oauth=await ensure("github-mcp-oauth-kv"),cache=await ensure("github-mcp-cache-kv");
let cfg=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
cfg=cfg.replaceAll("__CF_ACCOUNT_ID__",zone.account.id).replaceAll("__CF_DOMAIN__",workerDomain).replaceAll("__OAUTH_KV_ID__",oauth).replaceAll("__CACHE_KV_ID__",cache);
await writeFile(new URL("../wrangler.deploy.jsonc",import.meta.url),cfg);
await writeFile(new URL("../worker-endpoint.txt",import.meta.url),"https://"+workerDomain+"/mcp\n");
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,"## GitHub MCP Proxy endpoint\n\nhttps://"+workerDomain+"/mcp\n");
if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,"CLOUDFLARE_ACCOUNT_ID="+zone.account.id+"\nCLOUDFLARE_API_KEY="+key+"\nCLOUDFLARE_EMAIL="+email+"\nWORKER_DOMAIN="+workerDomain+"\n");
console.error("Prepared Cloudflare deployment config for "+workerDomain+"; account and credentials are not printed.");