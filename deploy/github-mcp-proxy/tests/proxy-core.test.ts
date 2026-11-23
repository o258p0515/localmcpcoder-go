import {describe,it,expect,vi,afterEach} from "vitest";
import {handleJsonRpcMessage} from "../src/mcp/proxy-core";
import {clearAccountCaches} from "../src/rtdb/account-store";
import {clearUpstreamSessions} from "../src/mcp/upstream-client";
afterEach(async()=>{vi.unstubAllGlobals();clearUpstreamSessions();await clearAccountCaches(makeEnv());});
function kv(){const m=new Map<string,string>();return {m,get:async(k:string)=>m.get(k)??null,put:async(k:string,v:string)=>m.set(k,v),delete:async(k:string)=>m.delete(k)} as any;}
function makeEnv(){return {MCP_TOKEN:"test-secret",RTDB_AUTH_URL:"https://unit.firebaseio.com/accounts.json?auth=x",CACHE_KV:kv(),OAUTH_KV:kv()} as any;}
const accountData={
 personal:{username:"me",token:"ghp_personal_pat",enabled:true},
 work:{username:"work-user",token:"ghp_work_pat",enabled:true,readonly:false}
};
describe("proxy core",()=>{
 it("cleans legacy account injection from a cached upstream catalog",async()=>{
  const e=makeEnv();e.CACHE_KV.m.set("mcp:tools_catalog:v1",JSON.stringify([{name:"get_me",description:"GitHub profile\n[Multi-account proxy: requires 'account' alias from list_github_accounts]",inputSchema:{type:"object",properties:{account:{type:"string"}},required:["account"]}}]));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:100,method:"tools/list",params:{}} as any,e,{method:"static_token",subject:"test"});
  const tool=r.result.tools.find((item:any)=>item.name==="get_me");expect(tool.inputSchema.required).toEqual([]);expect(tool.inputSchema.properties.account).toBeUndefined();expect(tool.description).toBe("GitHub profile");
 });
 it("rejects missing or invalid account without upstream fallback",async()=>{
  const e=makeEnv();await clearAccountCaches(e);
  const fetch=vi.fn(async()=>Response.json({personal:{username:"me",token:"ghp_private",enabled:true}}));
  vi.stubGlobal("fetch",fetch);
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_me",arguments:{account:"wrong"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("personal");expect(fetch).toHaveBeenCalledTimes(1);
 });
 it.each(["delete_issue","issue_write","pull_request_review_write","sub_issue_write","create_repository","run_secret_scanning"])("blocks %s on readonly accounts",async(name)=>{
  const e=makeEnv();await clearAccountCaches(e);
  const fetch=vi.fn(async()=>Response.json({work:{username:"work",token:"ghp_private",enabled:true,readonly:true}}));
  vi.stubGlobal("fetch",fetch);
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:2,method:"tools/call",params:{name,arguments:{account:"work",name:"should-not-create"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain("read-only");expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("forwards the selected PAT and strips account from upstream arguments",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
   const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_selected_pat",enabled:true}});
   calls.push({url,init});return Response.json({jsonrpc:"2.0",id:9,result:{content:[{type:"text",text:"ok"}]}});
  }));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"get_me",arguments:{account:"personal",extra:"value"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.content[0].text).toBe("ok");const toolCall=calls.find(x=>JSON.parse(x.init.body).method==="tools/call");const forwarded=JSON.parse(toolCall.init.body);
  expect(forwarded.params.arguments).toEqual({extra:"value"});expect(toolCall.init.headers.get("Authorization")).toBe("Bearer ghp_selected_pat");
 });
 it("remembers the selected account per authenticated MCP session without cross-session leakage",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const upstreamCalls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
   const url=String(input);
   if(url.includes("accounts.json"))return Response.json(accountData);
   if(url.includes("api.githubcopilot.com")){
    const request=JSON.parse(init.body);const authorization=init.headers.get("Authorization");upstreamCalls.push({method:request.method,authorization});
    if(request.method==="initialize")return Response.json({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}},{headers:{"Mcp-Session-Id":"upstream-"+authorization}});
    return Response.json({jsonrpc:"2.0",id:request.id??"notification",result:{content:[{type:"text",text:"ok"}]}});
   }
   throw new Error("Unexpected fetch "+url);
  }));
  const sessionA={method:"static_token" as const,subject:"same-client",sessionId:"session-a"};
  const sessionB={method:"static_token" as const,subject:"same-client",sessionId:"session-b"};
  const chooseA=await handleJsonRpcMessage({jsonrpc:"2.0",id:10,method:"tools/call",params:{name:"select_github_account",arguments:{alias:"personal"}}} as any,e,sessionA);
  const chooseB=await handleJsonRpcMessage({jsonrpc:"2.0",id:11,method:"tools/call",params:{name:"select_github_account",arguments:{alias:"work"}}} as any,e,sessionB);
  expect(chooseA.result.isError).toBeFalsy();expect(chooseB.result.isError).toBeFalsy();
  await handleJsonRpcMessage({jsonrpc:"2.0",id:12,method:"tools/call",params:{name:"get_me",arguments:{}}} as any,e,sessionA);
  await handleJsonRpcMessage({jsonrpc:"2.0",id:13,method:"tools/call",params:{name:"get_me",arguments:{}}} as any,e,sessionB);
  const auths=upstreamCalls.filter(x=>x.method==="tools/call").map(x=>x.authorization);
  expect(auths).toEqual(["Bearer ghp_personal_pat","Bearer ghp_work_pat"]);
  const noSession=await handleJsonRpcMessage({jsonrpc:"2.0",id:14,method:"tools/call",params:{name:"get_me",arguments:{}}} as any,e,{method:"static_token",subject:"same-client",sessionId:"session-c"});
  expect(noSession.result.isError).toBe(true);
  const invalid=await handleJsonRpcMessage({jsonrpc:"2.0",id:15,method:"tools/call",params:{name:"select_github_account",arguments:{alias:"missing"}}} as any,e,{...sessionA,sessionId:"session-invalid"});
  expect(invalid.result.isError).toBe(true);
 });
 it("scopes selection to authenticated client identity when transport omits a session id",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const upstreamCalls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
   const url=String(input);
   if(url.includes("accounts.json"))return Response.json(accountData);
   if(url.includes("api.githubcopilot.com")){
    const request=JSON.parse(init.body);const authorization=init.headers.get("Authorization");upstreamCalls.push({method:request.method,authorization});
    if(request.method==="initialize")return Response.json({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}},{headers:{"Mcp-Session-Id":"upstream-"+authorization}});
    return Response.json({jsonrpc:"2.0",id:request.id??"notification",result:{content:[{type:"text",text:"ok"}]}});
   }
   throw new Error("Unexpected fetch "+url);
  }));
  const clientA={method:"oauth" as const,subject:"oauth-client-a"};
  const clientB={method:"oauth" as const,subject:"oauth-client-b"};
  const chooseA=await handleJsonRpcMessage({jsonrpc:"2.0",id:16,method:"tools/call",params:{name:"select_github_account",arguments:{alias:"personal"}}} as any,e,clientA);
  const chooseB=await handleJsonRpcMessage({jsonrpc:"2.0",id:17,method:"tools/call",params:{name:"select_github_account",arguments:{alias:"work"}}} as any,e,clientB);
  expect(chooseA.result.isError).toBeFalsy();expect(chooseB.result.isError).toBeFalsy();
  await handleJsonRpcMessage({jsonrpc:"2.0",id:18,method:"tools/call",params:{name:"get_me",arguments:{}}} as any,e,clientA);
  await handleJsonRpcMessage({jsonrpc:"2.0",id:19,method:"tools/call",params:{name:"get_me",arguments:{}}} as any,e,clientB);
  const auths=upstreamCalls.filter(x=>x.method==="tools/call").map(x=>x.authorization);
  expect(auths).toEqual(["Bearer ghp_personal_pat","Bearer ghp_work_pat"]);
 });
});
describe("create_repository REST compatibility",()=>{
 it("creates a repository through GitHub REST and preserves private/default options",async()=>{
  const e=makeEnv();await clearAccountCaches(e);const calls:any[]=[];
  vi.stubGlobal("fetch",vi.fn(async(input:any,init:any)=>{
   const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_test_token_value",enabled:true}});
   if(url==="https://api.github.com/user")return Response.json({login:"me"},{status:200});
   calls.push({url,init});return Response.json({id:123,full_name:"me/probe-repo",html_url:"https://github.com/me/probe-repo",private:true,default_branch:"main"},{status:201});
  }));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:20,method:"tools/call",params:{name:"create_repository",arguments:{account:"personal",name:"probe-repo",private:true,autoInit:true}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBeFalsy();expect(JSON.parse(r.result.content[0].text).repository.full_name).toBe("me/probe-repo");
  expect(calls).toHaveLength(1);expect(calls[0].url).toBe("https://api.github.com/user/repos");expect(JSON.parse(calls[0].init.body)).toEqual({name:"probe-repo",private:true,auto_init:true});
 });
 it("returns GitHub permission diagnostics instead of hiding 404/403 details",async()=>{
  const e=makeEnv();await clearAccountCaches(e);
  vi.stubGlobal("fetch",vi.fn(async(input:any)=>{
   const url=String(input);if(url.includes("accounts.json"))return Response.json({personal:{username:"me",token:"ghp_test_token_value",enabled:true}});
   if(url==="https://api.github.com/user")return Response.json({login:"me"});
   return new Response(JSON.stringify({message:"Resource not accessible by integration"}),{status:403,headers:{"X-Accepted-GitHub-Permissions":"Administration=write"}});
  }));
  const r=await handleJsonRpcMessage({jsonrpc:"2.0",id:21,method:"tools/call",params:{name:"create_repository",arguments:{account:"personal",name:"probe-repo"}}} as any,e,{method:"static_token",subject:"test"});
  expect(r.result.isError).toBe(true);const body=JSON.parse(r.result.content[0].text);expect(body.status).toBe(403);expect(body.required_permissions).toBe("Administration=write");
 });
});
