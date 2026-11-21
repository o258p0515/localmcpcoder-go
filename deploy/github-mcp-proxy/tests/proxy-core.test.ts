import {describe,it,expect,vi,afterEach} from "vitest";
import {handleJsonRpcMessage} from "../src/mcp/proxy-core";
import {clearAccountCaches} from "../src/rtdb/account-store";
function kv(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>m.set(k,v),delete:async(k:string)=>m.delete(k)} as any;}
function makeEnv(){return {MCP_TOKEN:"test-secret",RTDB_AUTH_URL:"https://unit.firebaseio.com/accounts.json?auth=x",CACHE_KV:kv(),OAUTH_KV:kv()} as any;}
describe("proxy core",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it("rejects missing or invalid account without upstream fallback",async()=>{const e=makeEnv();await clearAccountCaches(e);const fetch=vi.fn(async()=>Response.json({personal:{username:"me",token:"ghp_private",enabled:true}}));vi.stubGlobal("fetch",fetch);const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_me",arguments:{account:"wrong"}}} as any,e,{method:"static_token",subject:"test"});expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("personal");expect(fetch).toHaveBeenCalledTimes(1);});
 it("blocks write tools on readonly accounts",async()=>{const e=makeEnv();await clearAccountCaches(e);const fetch=vi.fn(async()=>Response.json({work:{username:"work",token:"ghp_private",enabled:true,readonly:true}}));vi.stubGlobal("fetch",fetch);const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"delete_issue",arguments:{account:"work"}}} as any,e,{method:"static_token",subject:"test"});expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("read-only");expect(fetch).toHaveBeenCalledTimes(1);});
});
 it("forwards the selected PAT and strips account from upstream arguments",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_selected_pat",enabled:true}});calls.push({url,init});return Response.json({jsonrpc:"2.0",id:9,result:{content:[{type:"text",text:"ok"}]}});}));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"get_me",arguments:{account:"personal",extra:"value"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.content[0].text).toBe("ok");const toolCall=calls.find(x=>JSON.parse(x.init.body).method==="tools/call");const forwarded=JSON.parse(toolCall.init.body);expect(forwarded.params.arguments).toEqual({extra:"value"});expect(toolCall.init.headers.get("Authorization")).toBe("Bearer ghp_selected_pat");
 });