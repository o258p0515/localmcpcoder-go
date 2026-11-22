import {describe,it,expect,vi,afterEach} from "vitest";
import {callUpstream,clearUpstreamSessions} from "../src/mcp/upstream-client";
const account:any={username:"me",token:"ghp_test",description:"test",orgs:[],enabled:true,readonly:false};
const env:any={};
describe("upstream HTTP diagnostics",()=>{
 afterEach(()=>{vi.unstubAllGlobals();clearUpstreamSessions();});
 it("does not misclassify an ordinary 404 as an expired MCP session",async()=>{
  const fetch=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}}),{status:200,headers:{"Content-Type":"application/json","Mcp-Session-Id":"s1"}}))
   .mockResolvedValueOnce(new Response("",{status:202}))
   .mockResolvedValueOnce(new Response("Not Found: /user/repos",{status:404,headers:{"Content-Type":"text/plain","X-GitHub-Request-Id":"req-1"}}));
  vi.stubGlobal("fetch",fetch);
  await expect(callUpstream(env,account,"personal",{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"create_repository",arguments:{}}})).rejects.toThrow(/HTTP 404.*request_id=req-1.*Not Found/);
 });
});
