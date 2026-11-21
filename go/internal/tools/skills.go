package tools

import (
	"context"
	"encoding/json"
	"fmt"
)
func (r *Registry) skillsList(_ context.Context,_ map[string]any)Result{if r.D.Skills==nil{return ok("No skills loaded")};b,_:=json.MarshalIndent(r.D.Skills.List(),"","  ");return ok(string(b))}
func (r *Registry) skillRead(_ context.Context,a map[string]any)Result{if r.D.Skills==nil{return fail("skills are unavailable")};v,e:=r.D.Skills.Read(val(a,"name"),val(a,"file"));if e!=nil{return fail(e.Error())};return ok(v)}
func (r *Registry) skillsReload(_ context.Context,_ map[string]any)Result{if r.D.Skills==nil{return fail("skills are unavailable")};if e:=r.D.Skills.Reload(r.D.Root,r.D.SkillsDir);e!=nil{return fail(e.Error())};return ok(fmt.Sprintf("Reloaded %d skills",len(r.D.Skills.List())))}
