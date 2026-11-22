import {describe,it,expect,vi,afterEach} from "vitest";
import {callUpstream,clearUpstreamSessions} from "../src/mcp/upstream-client";
const account:any={username:"me",token:"ghp_test",description:"test",orgs:[],enabled:true,readonly:false};
const env:any={};
describe("upstream HTTP diagnostics",()=>{
 afterEach(()=>{vi.unstubAllGlobals();clearUpstreamSessions();});
 it("preserves an initial HTTP 404 instead of misclassifying it as an expired session",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(new Response("Not Found: invalid upstream endpoint",{status:404,headers:{"Content-Type":"text/plain","X-GitHub-Request-Id":"req-1"}})));
  await expect(callUpstream(env,account,"personal",{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"get_me",arguments:{}}})).rejects.toThrow(/HTTP 404.*request_id=req-1.*Not Found/);
 });
 it("reinitializes when an established MCP session returns HTTP 404",async()=>{
  const fetch=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}}),{status:200,headers:{"Content-Type":"application/json","Mcp-Session-Id":"s1"}}))
   .mockResolvedValueOnce(new Response("",{status:202}))
   .mockResolvedValueOnce(new Response("Not Found",{status:404,headers:{"Content-Type":"text/plain"}}))
   .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}}),{status:200,headers:{"Content-Type":"application/json","Mcp-Session-Id":"s2"}}))
   .mockResolvedValueOnce(new Response("",{status:202}))
   .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:"2.0",id:2,result:{content:[{type:"text",text:"ok"}]}}),{status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch",fetch);
  const result=await callUpstream(env,account,"personal",{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"get_me",arguments:{}}});
  expect(result.result.content[0].text).toBe("ok");
  expect(fetch).toHaveBeenCalledTimes(6);
 });

 it("parses CRLF-delimited SSE responses",async()=>{
  const fetch=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:"2.0",id:"proxy-init",result:{protocolVersion:"2025-03-26"}}),{status:200,headers:{"Content-Type":"application/json","Mcp-Session-Id":"sse1"}}))
   .mockResolvedValueOnce(new Response("",{status:202}))
   .mockResolvedValueOnce(new Response('event: message\r\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"sse-ok"}]}}\r\n\r\n',{status:200,headers:{"Content-Type":"text/event-stream"}}));
  vi.stubGlobal("fetch",fetch);
  const result=await callUpstream(env,account,"personal",{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"get_me",arguments:{}}});
  expect(result.result.content[0].text).toBe("sse-ok");
 });
});
