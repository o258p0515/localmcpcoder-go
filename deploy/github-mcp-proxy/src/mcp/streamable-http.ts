import type { Env,AuthContext,JsonRpc } from "../types";
import { handleJsonRpcBatch,handleJsonRpcMessage } from "./proxy-core";
export async function handleStreamableHttp(req:Request,env:Env,ctx:AuthContext):Promise<Response>{
 if(req.method==="GET")return new Response("Method Not Allowed",{status:405,headers:{Allow:"POST, DELETE, OPTIONS"}});
 if(req.method==="DELETE")return Response.json({ok:true});
 if(req.method!=="POST")return new Response("Method Not Allowed",{status:405});
 let body:any;try{body=await req.json();}catch{return Response.json({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}},{status:400});}
 if(Array.isArray(body)){const responses=await handleJsonRpcBatch(body,env,ctx);return responses.length?Response.json(responses):new Response(null,{status:202});}
 const response=await handleJsonRpcMessage(body as JsonRpc,env,ctx);return response?Response.json(response):new Response(null,{status:202});
}