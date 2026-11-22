import {describe,it,expect,vi,afterEach} from "vitest";
import {handleJsonRpcMessage} from "../src/mcp/proxy-core";
import {clearAccountCaches} from "../src/rtdb/account-store";
function kv(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>m.set(k,v),delete:async(k:string)=>m.delete(k)} as any;}
function makeEnv(){return {MCP_TOKEN:"test-secret",RTDB_AUTH_URL:"https://unit.firebaseio.com/accounts.json?auth=x",CACHE_KV:kv(),OAUTH_KV:kv()} as any;}
describe("proxy core",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it("rejects missing or invalid account without upstream fallback",async()=>{const e=makeEnv();await clearAccountCaches(e);const fetch=vi.fn(async()=>Response.json({personal:{username:"me",token:"ghp_private",enabled:true}}));vi.stubGlobal("fetch",fetch);const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_me",arguments:{account:"wrong"}}} as any,e,{method:"static_token",subject:"test"});expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("personal");expect(fetch).toHaveBeenCalledTimes(1);});
 it.each(["delete_issue","issue_write","pull_request_review_write","sub_issue_write","create_repository"])("blocks %s on readonly accounts",async(name)=>{const e=makeEnv();await clearAccountCaches(e);const fetch=vi.fn(async()=>Response.json({work:{username:"work",token:"ghp_private",enabled:true,readonly:true}}));vi.stubGlobal("fetch",fetch);const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:2,method:"tools/call",params:{name,arguments:{account:"work",name:"should-not-create"}}} as any,e,{method:"static_token",subject:"test"});expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("read-only");expect(fetch).toHaveBeenCalledTimes(1);});
});
 it("forwards the selected PAT and strips account from upstream arguments",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_selected_pat",enabled:true}});calls.push({url,init});return Response.json({jsonrpc:"2.0",id:9,result:{content:[{type:"text",text:"ok"}]}});}));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"get_me",arguments:{account:"personal",extra:"value"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.content[0].text).toBe("ok");const toolCall=calls.find(x=>JSON.parse(x.init.body).method==="tools/call");const forwarded=JSON.parse(toolCall.init.body);expect(forwarded.params.arguments).toEqual({extra:"value"});expect(toolCall.init.headers.get("Authorization")).toBe("Bearer ghp_selected_pat");
 });
describe("create_repository REST compatibility",()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it("creates a repository through GitHub REST and preserves private/default options",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
   const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_test_token_value",enabled:true}});
   if(url==="https://api.github.com/user")return Response.json({login:"me"},{status:200});
   calls.push({url,init});return Response.json({id:123,full_name:"me/probe-repo",html_url:"https://github.com/me/probe-repo",private:true,default_branch:"main"},{status:201});
  }));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:10,method:"tools/call",params:{name:"create_repository",arguments:{account:"personal",name:"probe-repo",private:true,autoInit:true}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBeFalsy();expect(JSON.parse(r.result.content[0].text).repository.full_name).toBe("me/probe-repo");
  expect(calls).toHaveLength(1);expect(calls[0].url).toBe("https://api.github.com/user/repos");expect(JSON.parse(calls[0].init.body)).toEqual({name:"probe-repo",private:true,auto_init:true});
 });
 it("returns GitHub permission diagnostics instead of hiding 404/403 details",async()=>{
  const e=makeEnv();await clearAccountCaches(e);
  vi.stubGlobal("fetch",vi.fn(async(input:any)=>{const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_test_token_value",enabled:true}});if(url==="https://api.github.com/user")return Response.json({login:"me"});return new Response(JSON.stringify({message:"Resource not accessible by integration"}),{status:403,headers:{"X-Accepted-GitHub-Permissions":"Administration=write"}});}));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:11,method:"tools/call",params:{name:"create_repository",arguments:{account:"personal",name:"probe-repo"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBe(true);const body=JSON.parse(r.result.content[0].text);expect(body.status).toBe(403);expect(body.required_permissions).toBe("Administration=write");
 });
});
