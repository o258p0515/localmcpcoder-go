import {describe,it,expect} from "vitest";
import {injectAccountParameter,getProxyCustomTools} from "../src/mcp/schema-injector";
describe("schema injection",()=>{
 it("removes the legacy proxy account argument from cached schemas without mutating source",()=>{
  const source:any={name:"issues",description:"Issues tool\n[Multi-account proxy: requires 'account' alias from list_github_accounts]",inputSchema:{type:"object",properties:{x:{type:"string"},account:{type:"string"}},required:["x","account"]}};
  const out=injectAccountParameter(source);
  expect(out.inputSchema?.required).toEqual(["x"]);expect(out.inputSchema?.properties?.account).toBeUndefined();
  expect(source.inputSchema.required).toEqual(["x","account"]);
 });
 it("preserves fresh upstream schemas unchanged",()=>{
  const source:any={name:"issues",inputSchema:{type:"object",properties:{x:{type:"string"}},required:["x"]}};
  expect(injectAccountParameter(source)).toEqual(source);
 });
 it("exposes account selection tools with the alias argument",()=>{
  const tools=getProxyCustomTools();expect(tools.map(x=>x.name)).toEqual(["list_github_accounts","select_github_account","refresh_accounts"]);
  expect(tools[1]?.inputSchema?.required).toEqual(["alias"]);
 });
});
