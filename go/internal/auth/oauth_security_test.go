package auth

import "testing"

func TestRegisterRejectsUnsafeRedirectSchemes(t *testing.T) { s:=New("0123456789abcdef"); for _,uri:=range []string{"javascript:alert(1)","data:text/plain,hi","file:///etc/passwd","http:relative"} { if s.Register("bad",[]string{uri})!="" { t.Fatalf("unsafe redirect accepted: %s",uri) } } }
