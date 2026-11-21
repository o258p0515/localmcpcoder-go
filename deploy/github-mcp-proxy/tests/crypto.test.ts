import {describe,it,expect} from "vitest";
import {decodeBase64Utf8,encryptAesGcm,decryptAesGcm,sha256Base64Url,timingSafeEqual} from "../src/utils/crypto";
describe("crypto utilities",()=>{
 it("decodes base64url and whitespace",()=>expect(decodeBase64Utf8(" eyJ4IjoxfQ==\n")).toBe('{"x":1}'));
 it("encrypts cache payloads",async()=>{const x=await encryptAesGcm("ghp_secret","master");expect(x).not.toContain("ghp_secret");expect(await decryptAesGcm(x,"master")).toBe("ghp_secret");});
 it("compares tokens and hashes PKCE",async()=>{expect(timingSafeEqual("abc","abc")).toBe(true);expect(timingSafeEqual("abc","abd")).toBe(false);expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");});
});