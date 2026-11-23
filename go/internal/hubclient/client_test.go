package hubclient

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWebsocketURLBuildsRunnerMetadata(t *testing.T) {
	c,err:=New(Config{HubURLs:"https://hub.example.com",Secret:"secret",Token:"0123456789abcdef",RunnerID:"test-01",RunnerTags:"linux,go",Port:8787})
	if err!=nil{t.Fatal(err)}
	got,err:=c.websocketURL("https://hub.example.com");if err!=nil{t.Fatal(err)}
	for _,want:=range []string{"wss://hub.example.com/internal/runner-ws","id=test-01","os=","arch=","tags=linux%2Cgo"}{if !strings.Contains(got,want){t.Fatalf("%q missing %q",got,want)}}
}
func TestNewRequiresHubCredentials(t *testing.T){
	if _,err:=New(Config{HubURLs:"https://hub.example.com",Token:"0123456789abcdef"});err==nil{t.Fatal("expected missing secret error")}
	if _,err:=New(Config{Secret:"secret",Token:"0123456789abcdef"});err==nil{t.Fatal("expected missing URL error")}
}
func TestShutdownDrainsActiveRequests(t *testing.T){
	c,err:=New(Config{HubURLs:"https://hub.example.com",Secret:"secret",Token:"0123456789abcdef"});if err!=nil{t.Fatal(err)}
	if !c.beginRequest(){t.Fatal("request was unexpectedly rejected")}
	ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel()
	if err:=c.Shutdown(ctx);err==nil{t.Fatal("expected deadline while request is active")}
	if c.beginRequest(){t.Fatal("new request accepted after draining began")}
	c.finishRequest()
}
