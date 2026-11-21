import {describe,it,expect} from "vitest";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
describe("environment validator",()=>{
 it("does not leak supplied secrets on invalid config",()=>{const secret="super-secret-value-not-to-leak";try{execFileSync(process.execPath,[resolve("scripts/validate-env.mjs")],{env:{...process.env,CF_API_EMAIL:"bad",CF_API_KEY:secret,MCP_TOKEN:secret,CF_DOMAIN:"https://bad",RTDB_AUTH_URL:"https://x.firebaseio.com/a.json?auth="+secret},stdio:"pipe"});}catch(e:any){const out=String(e.stderr||"");expect(out).not.toContain(secret);expect(out).toContain("CF_DOMAIN");}});
});