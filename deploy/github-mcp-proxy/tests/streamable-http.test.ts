import {describe,it,expect} from "vitest";
import {handleStreamableHttp} from "../src/mcp/streamable-http";
function kv(){return {get:async()=>null,put:async()=>{},delete:async()=>{}} as any;}
describe("streamable HTTP MCP sessions",()=>{
 it("issues an MCP session id during initialize",async()=>{
  const env:any={MCP_TOKEN:"test",CACHE_KV:kv(),OAUTH_KV:kv()};
  const req=new Request("https://proxy.example/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}}})});
  const response=await handleStreamableHttp(req,env,{method:"static_token",subject:"test"});
  expect(response.status).toBe(200);
  expect(response.headers.get("Mcp-Session-Id")).toBeTruthy();
 });
});
