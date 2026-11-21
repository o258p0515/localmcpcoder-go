package tools

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
)
// Add registers a typed tool handler. Input fields use encoding/json tags;
// optional `description` and `required:"true"` tags enrich the generated schema.
// Errors are returned as MCP isError results rather than HTTP failures.
func Add[In any](r *Registry, spec Spec, handler func(context.Context, Deps, In) (Result, error)) {
	if r.Items == nil { r.Items = map[string]Spec{} }; if r.Handlers == nil { r.Handlers = map[string]Handler{} }; if spec.InputSchema == nil { spec.InputSchema = typedSchema[In]() }; r.Items[spec.Name] = spec
	r.Handlers[spec.Name] = func(ctx context.Context,args map[string]any)Result{raw,e:=json.Marshal(args);if e!=nil{return fail(e.Error())};var in In;if e=json.Unmarshal(raw,&in);e!=nil{return fail(e.Error())};out,e:=handler(ctx,r.D,in);if e!=nil{return fail(e.Error())};return out}
}
func typedSchema[T any]()map[string]any{typ:=reflect.TypeOf((*T)(nil)).Elem();for typ.Kind()==reflect.Pointer{typ=typ.Elem()};props:=map[string]any{};var required []string;if typ.Kind()==reflect.Struct{for i:=0;i<typ.NumField();i++{f:=typ.Field(i);if !f.IsExported(){continue};name:=strings.Split(f.Tag.Get("json"),",")[0];if name==""{name=f.Name};if name=="-"{continue};p:=map[string]any{"type":schemaType(f.Type)};if d:=f.Tag.Get("description");d!=""{p["description"]=d};props[name]=p;if f.Tag.Get("required")=="true"||(!strings.Contains(f.Tag.Get("json"),"omitempty")&&f.Type.Kind()!=reflect.Pointer){required=append(required,name)}}};schema:=map[string]any{"type":"object","properties":props};if len(required)>0{schema["required"]=required};return schema}
func schemaType(t reflect.Type)string{for t.Kind()==reflect.Pointer{t=t.Elem()};switch t.Kind(){case reflect.String:return "string";case reflect.Bool:return "boolean";case reflect.Int,reflect.Int8,reflect.Int16,reflect.Int32,reflect.Int64,reflect.Uint,reflect.Uint8,reflect.Uint16,reflect.Uint32,reflect.Uint64:return "integer";case reflect.Float32,reflect.Float64:return "number";case reflect.Slice,reflect.Array:return "array";case reflect.Map,reflect.Struct:return "object";default:return "string"}}
