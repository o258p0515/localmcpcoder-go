import {describe,it,expect} from "vitest";
import {SseSessionDO} from "../src/mcp/sse-session-do";
function makeState(){
 const values=new Map<string,unknown>();
 return {storage:{get:async(key:string)=>values.get(key),put:async(key:string,value:unknown)=>{values.set(key,value);},delete:async(key:string)=>values.delete(key)} as any};
}
describe("durable account selection storage",()=>{
 it("persists the selected alias across Durable Object instances",async()=>{
  const state=makeState();const env:any={};
  const first=new SseSessionDO(state as any,env);
  const saved=await first.fetch(new Request("https://session.internal/_internal/account-selection",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({alias:"personal"})}));
  expect(saved.status).toBe(200);
  const second=new SseSessionDO(state as any,env);
  const read=await second.fetch(new Request("https://session.internal/_internal/account-selection"));
  expect((await read.json() as any).alias).toBe("personal");
 });
 it("rejects empty aliases",async()=>{
  const state=makeState();const session=new SseSessionDO(state as any,{} as any);
  const response=await session.fetch(new Request("https://session.internal/_internal/account-selection",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({alias:" "})}));
  expect(response.status).toBe(400);
 });
});
