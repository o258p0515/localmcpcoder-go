import type { Env,AuthContext,JsonRpc } from "../types";
import { handleJsonRpcMessage } from "./proxy-core";
export class SseSessionDO {
 private writer:WritableStreamDefaultWriter<Uint8Array>|null=null;
 private env:Env;
 private auth:AuthContext|null=null;
 constructor(_state:DurableObjectState,env:Env){this.env=env;}
 async fetch(req:Request):Promise<Response>{
  const u=new URL(req.url);
  const method=req.headers.get("X-Proxy-Auth-Method");if(method==="oauth"||method==="static_token")this.auth={method,subject:req.headers.get("X-Proxy-Subject")||"proxy",pinnedAccount:req.headers.get("X-GitHub-Account")||undefined,sessionId:u.searchParams.get("sessionId")||undefined};
  if(req.method==="GET"&&u.pathname.endsWith("/sse")){
   if(this.writer)try{await this.writer.close();}catch{}
   const stream=new TransformStream<Uint8Array,Uint8Array>();this.writer=stream.writable.getWriter();
   const sessionId=u.searchParams.get("sessionId")||"";
   await this.writer.write(new TextEncoder().encode("event: endpoint\ndata: /messages?sessionId="+encodeURIComponent(sessionId)+"\n\n"));
   const writer=this.writer;const timer=setInterval(()=>{writer.write(new TextEncoder().encode(": keepalive\n\n")).catch(()=>clearInterval(timer));},25000);
   req.signal.addEventListener("abort",()=>{clearInterval(timer);writer.close().catch(()=>{});this.writer=null;},{once:true});
   return new Response(stream.readable,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"}});
  }
  if(req.method==="POST"&&u.pathname.endsWith("/messages")){
   if(!this.writer)return Response.json({error:"SSE session not found or closed. Reconnect to /sse."},{status:404});
   const msg=await req.json() as JsonRpc;const response=await handleJsonRpcMessage(msg,this.env,this.auth||{method:"static_token",subject:"sse"});
   if(response)await this.writer.write(new TextEncoder().encode("event: message\ndata: "+JSON.stringify(response)+"\n\n"));
   return new Response(null,{status:202});
  }
  return new Response("Not Found",{status:404});
 }
 setAuth(auth:AuthContext){this.auth=auth;}
}