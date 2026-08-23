//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32        = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutex = kernel32.NewProc("CreateMutexW")
	procCloseHandle = kernel32.NewProc("CloseHandle")
	mutexHandle     uintptr
)

// lockSingleInstance 尝试创建命名互斥体；已存在则返回 false。
func lockSingleInstance(name string) bool {
	ptr, _ := syscall.UTF16PtrFromString(name)
	h, _, err := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(ptr)))
	if h == 0 {
		return false
	}
	if errno, ok := err.(syscall.Errno); ok && errno == 183 { // ERROR_ALREADY_EXISTS
		procCloseHandle.Call(h)
		return false
	}
	mutexHandle = h
	return true
}

func unlockSingleInstance() {
	if mutexHandle != 0 {
		procCloseHandle.Call(mutexHandle)
		mutexHandle = 0
	}
}
