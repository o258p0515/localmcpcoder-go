const allow = ["MCP_TOKEN","MCP_OAUTH_CLIENT_ID","MCP_OAUTH_CLIENT_SECRET","RTDB_URL","RTDB_AUTH_URL","FIREBASE_SERVICE_ACCOUNT_JSON_B64","FIREBASE_SERVICE_ACCOUNT_JSON"];
const out = {};
for (const key of allow) { const value=process.env[key]; if(typeof value==="string"&&value.trim()) out[key]=value; }
process.stdout.write(JSON.stringify(out));