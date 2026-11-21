import {describe,it,expect} from "vitest";
import {injectAccountParameter,getProxyCustomTools} from "../src/mcp/schema-injector";
describe("schema injection",()=>{
 it("adds required account without mutating source",()=>{const source:any={name:"issues",inputSchema:{type:"object",properties:{x:{type:"string"}},required:["x"]}};const out=injectAccountParameter(source);expect(out.inputSchema?.required).toEqual(["x","account"]);expect(out.inputSchema?.properties?.account).toBeTruthy();expect(source.inputSchema.required).toEqual(["x"]);});
 it("exposes proxy tools",()=>expect(getProxyCustomTools().map(x=>x.name)).toEqual(["list_github_accounts","refresh_accounts"]));
});