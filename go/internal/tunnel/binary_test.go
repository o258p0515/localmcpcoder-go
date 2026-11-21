package tunnel

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveEnvOverride(t *testing.T) {
	d:=t.TempDir();p:=filepath.Join(d,"fake");if e:=os.WriteFile(p,[]byte("#!/bin/sh\nexit 0\n"),0755);e!=nil{t.Fatal(e)};t.Setenv("TEST_BIN",p);got,e:=Resolve("missing-binary",DownloadSpec{EnvOverride:"TEST_BIN"});if e!=nil{t.Fatal(e)};if got!=p{t.Fatalf("got %s",got)}
}
func TestResolveRejectsHTTP(t *testing.T) { t.Setenv("PATH","");if _,e:=Resolve("definitely-not-installed",DownloadSpec{URL:"http://example.invalid/file"});e==nil{t.Fatal("non-HTTPS download accepted")} }
func TestResolveLookPathAndCache(t *testing.T) {
	d:=t.TempDir();bin:=filepath.Join(d,"bin");_=os.Mkdir(bin,0755);p:=filepath.Join(bin,"path-tool");_=os.WriteFile(p,[]byte("#!/bin/sh\nexit 0\n"),0755);t.Setenv("PATH",bin);got,e:=Resolve("path-tool",DownloadSpec{});if e!=nil||got!=p{t.Fatalf("lookpath: %s %v",got,e)}
	cache:=filepath.Join(d,"cache");t.Setenv("XDG_CACHE_HOME",cache);t.Setenv("PATH","");target:=filepath.Join(cache,"localmcpcoder","bin","cached-tool-v1");_=os.MkdirAll(filepath.Dir(target),0755);_=os.WriteFile(target,[]byte("#!/bin/sh\nexit 0\n"),0755);got,e=Resolve("cached-tool",DownloadSpec{Version:"v1"});if e!=nil||got!=target{t.Fatalf("cache: %s %v",got,e)}
}
func TestResolveHTTPSDownloadAndChecksum(t *testing.T) {
	data:=[]byte("#!/bin/sh\necho ok\n");sum:=sha256.Sum256(data);server:=httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.Write(data)}));defer server.Close();old:=http.DefaultClient;http.DefaultClient=server.Client();defer func(){http.DefaultClient=old}();d:=t.TempDir();t.Setenv("XDG_CACHE_HOME",d);t.Setenv("PATH","");got,e:=Resolve("downloaded",DownloadSpec{URL:server.URL+"/bin",Version:"v9",SHA256:hex.EncodeToString(sum[:])});if e!=nil{t.Fatal(e)};if !executable(got){t.Fatalf("download not executable: %s",got)}
}
func TestResolveArchiveDownloads(t *testing.T) {
	binary:=[]byte("#!/bin/sh\nexit 0\n");var tgz bytes.Buffer;gz:=gzip.NewWriter(&tgz);tw:=tar.NewWriter(gz);_=tw.WriteHeader(&tar.Header{Name:"cloudflared",Mode:0755,Size:int64(len(binary))});_,_=tw.Write(binary);_=tw.Close();_=gz.Close();var zipbuf bytes.Buffer;zw:=zip.NewWriter(&zipbuf);w,_:=zw.Create("nested/cloudflared");_,_=w.Write(binary);_=zw.Close()
	cases:=[]struct{name,archive string;data []byte}{{"tgz","tgz",tgz.Bytes()},{"zip","zip",zipbuf.Bytes()}}
	for _,tc:=range cases{t.Run(tc.name,func(t *testing.T){srv:=httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){_,_=w.Write(tc.data)}));defer srv.Close();old:=http.DefaultClient;http.DefaultClient=srv.Client();defer func(){http.DefaultClient=old}();cache:=t.TempDir();t.Setenv("XDG_CACHE_HOME",cache);t.Setenv("PATH","");p,e:=Resolve("cloudflared",DownloadSpec{URL:srv.URL+"/asset",Version:"archive-"+tc.name,Archive:tc.archive});if e!=nil{t.Fatal(e)};if !executable(p){t.Fatalf("archive extraction not executable: %s",p)}})}
}
func TestResolveRejectsBadChecksum(t *testing.T) {
	data:=[]byte("not the expected binary");srv:=httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){_,_=w.Write(data)}));defer srv.Close();old:=http.DefaultClient;http.DefaultClient=srv.Client();defer func(){http.DefaultClient=old}();t.Setenv("XDG_CACHE_HOME",t.TempDir());t.Setenv("PATH","");if _,e:=Resolve("bad-checksum",DownloadSpec{URL:srv.URL,Version:"bad",SHA256:strings.Repeat("0",64)});e==nil{t.Fatal("bad checksum accepted")}
}
