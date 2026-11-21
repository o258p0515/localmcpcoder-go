//go:build windows

package tools

import (
	"os/exec"
	"strconv"
	"syscall"
)
func configureProcess(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{CreationFlags:syscall.CREATE_NEW_PROCESS_GROUP}; c.Cancel = func()error{if c.Process==nil{return nil};return exec.Command("taskkill","/PID",strconv.Itoa(c.Process.Pid),"/T","/F").Run()} }
