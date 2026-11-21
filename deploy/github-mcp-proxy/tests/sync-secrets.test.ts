import {describe,it,expect} from "vitest";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
describe("runtime secret allowlist",()=>{
 it("filters empty and non-runtime secrets",()=>{const out=execFileSync(process.execPath,[resolve("scripts/sync-secrets.mjs")],{env:{MCP_TOKEN:"token",CF_API_KEY:"must-not-pass",TS_TRUST_CREDS:"must-not-pass",MCP_OAUTH_REDIRECT_URIS:"must-not-pass",RTDB_URL:" ",FIREBASE_SERVICE_ACCOUNT_JSON_B64:"base64"},encoding:"utf8"});expect(JSON.parse(out)).toEqual({MCP_TOKEN:"token",FIREBASE_SERVICE_ACCOUNT_JSON_B64:"base64"});});
});