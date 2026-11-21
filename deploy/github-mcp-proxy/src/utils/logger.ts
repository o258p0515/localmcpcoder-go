export function redactSecrets(input:string):string {
 return input.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b|\bgithub_pat_[A-Za-z0-9_]+\b/g,"[REDACTED]")
 .replace(/([?&](?:auth|access_token|token|key|secret)=)[^&\s"']+/gi,"$1[REDACTED]")
 .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,"$1[REDACTED]")
 .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,"[REDACTED]");
}
export function auditLog(event:Record<string,unknown>){console.log(redactSecrets(JSON.stringify(event)));}