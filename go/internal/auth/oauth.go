package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)
type Options struct { Passphrase, ClientID, ClientSecret, ClientName string; RedirectURIs []string }
type Service struct { pass string; key []byte; mu sync.Mutex; used map[string]int64; fails int; locked time.Time; staticID, staticSecret, staticName string; staticRedirects map[string]bool }
type Claims struct { Typ string `json:"typ,omitempty"`; ClientID string `json:"client_id,omitempty"`; ClientName string `json:"client_name,omitempty"`; RedirectURIs []string `json:"redirect_uris,omitempty"`; RedirectURI string `json:"redirect_uri,omitempty"`; Challenge string `json:"code_challenge,omitempty"`; Resource string `json:"resource,omitempty"`; Scope string `json:"scope,omitempty"`; Aud string `json:"aud,omitempty"`; CID string `json:"cid,omitempty"`; Exp int64 `json:"exp"` }
func NewWithOptions(o Options)*Service {
 s:=New(o.Passphrase)
 s.staticID=o.ClientID; s.staticSecret=o.ClientSecret; s.staticName=o.ClientName
 if s.staticName=="" { s.staticName="Pre-registered MCP client" }
 s.staticRedirects=map[string]bool{}
 for _,v:=range o.RedirectURIs { if validRedirect(v) { s.staticRedirects[v]=true } }
 return s
}
func validRedirect(v string) bool { u,e:=url.Parse(v); if e!=nil||!u.IsAbs()||u.Host=="" { return false }; scheme:=strings.ToLower(u.Scheme); return scheme=="https"||scheme=="http"||scheme=="myapp"||scheme=="vscode"||scheme=="cursor"||scheme=="claude"||scheme=="chatgpt" }
func(s *Service) AuthenticateClient(id,secret string) bool {
 if s.staticID=="" || id!=s.staticID || s.staticSecret=="" { return false }
 return len(secret)==len(s.staticSecret) && subtle.ConstantTimeCompare([]byte(secret),[]byte(s.staticSecret))==1
}
func(s *Service) StaticClient() (string,string,[]string,bool) {
 if s.staticID=="" || len(s.staticRedirects)==0 { return "","",nil,false }
 uris:=make([]string,0,len(s.staticRedirects)); for u:=range s.staticRedirects { uris=append(uris,u) }
 return s.staticID,s.staticName,uris,true
}
func New(pass string)*Service{salt:=[]byte("localmcpcoder/oauth/v1");extract:=hmac.New(sha256.New,salt);extract.Write([]byte(pass));prk:=extract.Sum(nil);expand:=hmac.New(sha256.New,prk);expand.Write([]byte("localmcpcoder stateless OAuth signing key"));expand.Write([]byte{1});return &Service{pass:pass,key:expand.Sum(nil),used:map[string]int64{}}}
func(s *Service)Sign(c Claims)string{b,_:=json.Marshal(c);p:=base64.RawURLEncoding.EncodeToString(b);m:=hmac.New(sha256.New,s.key);m.Write([]byte(p));return p+"."+base64.RawURLEncoding.EncodeToString(m.Sum(nil))}
func(s *Service)Verify(t string)(Claims,error){var c Claims;p:=strings.Split(t,".");if len(p)!=2{return c,errors.New("malformed token")};sig,e:=base64.RawURLEncoding.DecodeString(p[1]);if e!=nil{return c,e};m:=hmac.New(sha256.New,s.key);m.Write([]byte(p[0]));if !hmac.Equal(sig,m.Sum(nil)){return c,errors.New("invalid token signature")};b,e:=base64.RawURLEncoding.DecodeString(p[0]);if e!=nil{return c,e};if e=json.Unmarshal(b,&c);e!=nil{return c,e};if c.Exp<time.Now().Unix(){return c,errors.New("token expired")};return c,nil}
func(s *Service)Register(name string,uris []string)string{if len(uris)==0{return ""};if name==""{name="Unnamed MCP client"};for _,v:=range uris{u,e:=url.Parse(v);if e!=nil||!u.IsAbs(){return ""};scheme:=strings.ToLower(u.Scheme);if scheme=="javascript"||scheme=="data"||scheme=="file"||((scheme=="http"||scheme=="https")&&u.Host==""){return ""}};return s.Sign(Claims{Typ:"client",ClientName:name,RedirectURIs:uris,Exp:time.Now().AddDate(10,0,0).Unix()})}
func(s *Service)ClientInfo(cid,redirect string)(string,error){
 if cid!="" && cid==s.staticID { if s.staticRedirects[redirect] { return s.staticName,nil }; return "",errors.New("redirect_uri does not match the pre-registered client") }
 c,e:=s.Verify(cid);if e!=nil||c.Typ!="client"{return "",errors.New("unknown client_id — register first")};for _,u:=range c.RedirectURIs{if u==redirect&&redirect!=""{return c.ClientName,nil}};return "",errors.New("redirect_uri does not match the one registered")}
func(s *Service)Locked()bool{s.mu.Lock();defer s.mu.Unlock();return time.Now().Before(s.locked)}
func(s *Service)AuthCode(cid,redirect,challenge,resource,scope string)(string,error){
 if cid==s.staticID && s.staticID!="" { if !s.staticRedirects[redirect] { return "",errors.New("redirect_uri mismatch") } } else {
 c,e:=s.Verify(cid);if e!=nil||c.Typ!="client"{return "",errors.New("invalid client_id")}
 ok:=false;for _,v:=range c.RedirectURIs{if v==redirect{ok=true}};if !ok{return "",errors.New("redirect_uri mismatch")}
 }
 decoded,de:=base64.RawURLEncoding.DecodeString(challenge);if de!=nil||len(decoded)!=sha256.Size{return "",errors.New("PKCE S256 challenge required")};return s.Sign(Claims{Typ:"code",ClientID:cid,RedirectURI:redirect,Challenge:challenge,Resource:resource,Scope:scope,Exp:time.Now().Add(time.Minute).Unix()}),nil}
func(s *Service)Exchange(code,verifier,resource,clientID,redirectURI string)(string,string,error){c,e:=s.Verify(code);if e!=nil||c.Typ!="code"{return "","",errors.New("invalid authorization code")};sum:=sha256.Sum256([]byte(verifier));if base64.RawURLEncoding.EncodeToString(sum[:])!=c.Challenge{return "","",errors.New("invalid PKCE verifier")};if resource==""{resource=c.Resource};if c.Resource!=""&&resource!=c.Resource{return "","",errors.New("resource audience mismatch")};if clientID==""||clientID!=c.ClientID{return "","",errors.New("client_id mismatch")};if redirectURI==""||redirectURI!=c.RedirectURI{return "","",errors.New("redirect_uri mismatch")};s.mu.Lock();now:=time.Now().Unix();for k,exp:=range s.used{if exp<now{delete(s.used,k)}};if _,ok:=s.used[code];ok{s.mu.Unlock();return "","",errors.New("authorization code already used")};s.used[code]=c.Exp;s.mu.Unlock();at:=s.Sign(Claims{Typ:"access",Aud:resource,Scope:c.Scope,CID:c.ClientID,Exp:time.Now().Add(time.Hour).Unix()});rt:=s.Sign(Claims{Typ:"refresh",CID:c.ClientID,Resource:resource,Scope:c.Scope,Exp:time.Now().Add(30*24*time.Hour).Unix()});return at,rt,nil}
func(s *Service)Refresh(rt string)(string,string,error){c,e:=s.Verify(rt);if e!=nil||c.Typ!="refresh"{return "","",errors.New("invalid refresh token")};a:=s.Sign(Claims{Typ:"access",Aud:c.Resource,Scope:c.Scope,CID:c.CID,Exp:time.Now().Add(time.Hour).Unix()});return a,rt,nil}
func(s *Service)Bearer(v,resource string)bool{if len(v)==len(s.pass)&&subtle.ConstantTimeCompare([]byte(v),[]byte(s.pass))==1{return true};c,e:=s.Verify(v);return e==nil&&c.Typ=="access"&&(c.Aud==resource||c.Aud==strings.TrimSuffix(resource,"/"))}
func(s *Service)CheckPass(v string)bool{s.mu.Lock();defer s.mu.Unlock();if time.Now().Before(s.locked){return false};ok:=len(v)==len(s.pass)&&subtle.ConstantTimeCompare([]byte(v),[]byte(s.pass))==1;if ok{s.fails=0;return true};s.fails++;if s.fails>=5{s.locked=time.Now().Add(60*time.Second);s.fails=0};return false}
func Origin(scheme,host string)string{if scheme!="https"&&scheme!="http"{scheme="https"};if host==""{host="localhost"};return fmt.Sprintf("%s://%s",scheme,host)}
