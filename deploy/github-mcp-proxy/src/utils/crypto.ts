export function base64UrlEncode(bytes: Uint8Array): string {
  let s=""; for (const b of bytes) s+=String.fromCharCode(b);
  return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
export function base64UrlDecode(s: string): Uint8Array {
  const x=s.replace(/-/g,"+").replace(/_/g,"/"); const bin=atob(x+"=".repeat((4-x.length%4)%4));
  return Uint8Array.from(bin,c=>c.charCodeAt(0));
}
export function decodeBase64Utf8(s:string):string {
  const x=s.replace(/\s+/g,"").replace(/-/g,"+").replace(/_/g,"/");
  const bin=atob(x+"=".repeat((4-x.length%4)%4)); return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(bin,c=>c.charCodeAt(0)));
}
export async function sha256Hex(s:string):Promise<string>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");}
export async function sha256Base64Url(s:string):Promise<string>{return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));}
export function randomToken(n=32):string{return base64UrlEncode(crypto.getRandomValues(new Uint8Array(n)));}
export function timingSafeEqual(a:string,b:string):boolean{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let d=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)d|=(x[i%Math.max(1,x.length)]??0)^(y[i%Math.max(1,y.length)]??0);return d===0;}
async function aesKey(secret:string){return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret)),{name:"AES-GCM"},false,["encrypt","decrypt"]);}
export async function encryptAesGcm(p:string,s:string):Promise<string>{const iv=crypto.getRandomValues(new Uint8Array(12));const c=await crypto.subtle.encrypt({name:"AES-GCM",iv},await aesKey(s),new TextEncoder().encode(p));return "v1:"+base64UrlEncode(iv)+"."+base64UrlEncode(new Uint8Array(c));}
export async function decryptAesGcm(v:string,s:string):Promise<string>{const m=/^v1:([^.]+)\.(.+)$/.exec(v);if(!m)throw Error("Unsupported encrypted cache format");const iv=base64UrlDecode(m[1]!).slice().buffer as ArrayBuffer;const data=base64UrlDecode(m[2]!).slice().buffer as ArrayBuffer;const p=await crypto.subtle.decrypt({name:"AES-GCM",iv},await aesKey(s),data);return new TextDecoder().decode(p);}