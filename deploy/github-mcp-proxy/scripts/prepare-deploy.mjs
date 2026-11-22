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
async function dnsRecords(hostname){
  return cf("/zones/"+zone.id+"/dns_records?name="+encodeURIComponent(hostname));
}
function pointsToWorkersDev(records){
  return records.some(record=>record.type==="CNAME"&&String(record.content||"").toLowerCase().endsWith(".workers.dev"));
}
const candidates=[domain,"github-mcp-proxy."+zone.name,"github-mcp-proxy-"+zone.account.id.slice(0,6).toLowerCase()+"."+zone.name];
let workerDomain="";
let availableDomain="";
for(const candidate of [...new Set(candidates)]){
  const records=await dnsRecords(candidate);
  if(pointsToWorkersDev(records)){workerDomain=candidate;break;}
  if(!availableDomain&&!records.some(record=>["A","AAAA","CNAME"].includes(record.type)))availableDomain=candidate;
}
if(workerDomain){
  console.error("Reusing the existing Worker-backed hostname to keep the MCP connector URL stable.");
}else if(availableDomain){
  workerDomain=availableDomain;
  console.error("Using an unused hostname while preserving externally managed DNS records.");
}else{
  throw new Error("No existing Worker-backed hostname or free proxy hostname was found. Preserve existing DNS; choose an unused hostname in the same Cloudflare zone.");
}
const legacyDomain="github-mcp-proxy-5b1b15.o258p0515.dpdns.org";
const legacyInZone=legacyDomain===zone.name||legacyDomain.endsWith("."+zone.name);
let publicDomain=workerDomain;
const workerRoutes=[{pattern:workerDomain,custom_domain:true}];
if(legacyInZone&&workerDomain!==legacyDomain){
  const legacyRecords=await dnsRecords(legacyDomain);
  const occupied=legacyRecords.some(record=>["A","AAAA","CNAME"].includes(record.type));
  if(pointsToWorkersDev(legacyRecords)||!occupied){
    workerRoutes.push({pattern:legacyDomain,custom_domain:true});
    publicDomain=legacyDomain;
    console.error("Keeping the existing ChatGPT connector hostname as a compatibility alias.");
  }else{
    console.error("Legacy connector hostname has unrelated DNS records; preserving them and not attaching the alias.");
  }
}
const namespaces=await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces?per_page=100");
async function ensure(title){const found=namespaces.find(x=>x.title===title);if(found)return found.id;return (await cf("/accounts/"+zone.account.id+"/storage/kv/namespaces",{method:"POST",body:JSON.stringify({title})})).id;}
const oauth=await ensure("github-mcp-oauth-kv"),cache=await ensure("github-mcp-cache-kv");
let cfg=await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8");
cfg=cfg.replaceAll("__CF_ACCOUNT_ID__",zone.account.id).replaceAll("__WORKER_ROUTES__",JSON.stringify(workerRoutes)).replaceAll("__PUBLIC_DOMAIN__",publicDomain).replaceAll("__OAUTH_KV_ID__",oauth).replaceAll("__CACHE_KV_ID__",cache);
await writeFile(new URL("../wrangler.deploy.jsonc",import.meta.url),cfg);
await writeFile(new URL("../worker-endpoint.txt",import.meta.url),"https://"+publicDomain+"/mcp\n");
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,"## GitHub MCP Proxy endpoint\n\nhttps://"+publicDomain+"/mcp\n");
if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,"CLOUDFLARE_ACCOUNT_ID="+zone.account.id+"\nCLOUDFLARE_API_KEY="+key+"\nCLOUDFLARE_EMAIL="+email+"\nWORKER_DOMAIN="+workerDomain+"\nPUBLIC_DOMAIN="+publicDomain+"\n");
console.error("Prepared Cloudflare deployment config for "+workerDomain+"; account and credentials are not printed.");