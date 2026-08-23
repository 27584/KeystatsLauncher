//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// 开机自启跟随：启动器检测 KeyStats 应用自身的自启状态（Run 键 "KeyStats" 值），
// 并把自己的自启状态（Run 键 "KeyStatsLauncher" 值）同步为一致：
// 应用开自启 → 启动器开自启；应用关自启 → 启动器关自启。
// 直接调用 advapi32 注册表 API，无外部依赖。
//
// 启动器自启项一律指向 GUI 版 KeyStatsLauncher.exe：即使当前跑的是控制台版
// （KeyStatsLauncher-console.exe，仅用于调试/子命令），自启也不指向它，
// 避免登录时弹出控制台窗口。

const (
	regRunKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	regAppValue   = "KeyStats"         // KeyStats 应用自身的自启值名
	regLchValue   = "KeyStatsLauncher" // 启动器的自启值名
)

const (
	regHKCU        = 0x80000001
	regAccessRead  = 0x0001 // KEY_QUERY_VALUE
	regAccessWrite = 0x0002 // KEY_SET_VALUE
	regTypeSZ      = 1
)

var (
	modAdvapi32          = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyExW    = modAdvapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW = modAdvapi32.NewProc("RegQueryValueExW")
	procRegSetValueExW   = modAdvapi32.NewProc("RegSetValueExW")
	procRegDeleteValueW  = modAdvapi32.NewProc("RegDeleteValueW")
	procRegCloseKey      = modAdvapi32.NewProc("RegCloseKey")
)

func regOpenRunKey(access uint32) (uintptr, error) {
	subKey, _ := syscall.UTF16PtrFromString(regRunKeyPath)
	var h uintptr
	ret, _, _ := procRegOpenKeyExW.Call(
		uintptr(regHKCU),
		uintptr(unsafe.Pointer(subKey)),
		0,
		uintptr(access),
		uintptr(unsafe.Pointer(&h)),
	)
	if ret != 0 {
		return 0, syscall.Errno(ret)
	}
	return h, nil
}

func regValueExists(h uintptr, name string) bool {
	namePtr, _ := syscall.UTF16PtrFromString(name)
	ret, _, _ := procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(namePtr)), 0, 0, 0, 0)
	return ret == 0
}

// regQueryString 读取 REG_SZ 值的数据；值不存在时返回 ("", false)。
func regQueryString(h uintptr, name string) (string, bool) {
	namePtr, _ := syscall.UTF16PtrFromString(name)
	var size uint32
	ret, _, _ := procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(namePtr)), 0, 0, 0, uintptr(unsafe.Pointer(&size)))
	if ret != 0 {
		return "", false
	}
	buf := make([]uint16, size/2+1)
	ret, _, _ = procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(namePtr)), 0, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ret != 0 {
		return "", false
	}
	return syscall.UTF16ToString(buf), true
}

func regSetString(h uintptr, name, value string) {
	namePtr, _ := syscall.UTF16PtrFromString(name)
	val, _ := syscall.UTF16FromString(value) // 含结尾 \0
	procRegSetValueExW.Call(
		h,
		uintptr(unsafe.Pointer(namePtr)),
		0,
		uintptr(regTypeSZ),
		uintptr(unsafe.Pointer(&val[0])),
		uintptr(len(val)*2),
	)
}

func regDeleteValue(h uintptr, name string) {
	namePtr, _ := syscall.UTF16PtrFromString(name)
	procRegDeleteValueW.Call(h, uintptr(unsafe.Pointer(namePtr)))
}

// appAutostartEnabled 返回 KeyStats 应用自身是否开启了开机自启。
func appAutostartEnabled() bool {
	h, err := regOpenRunKey(regAccessRead)
	if err != nil {
		return false
	}
	defer procRegCloseKey.Call(h)
	return regValueExists(h, regAppValue)
}

// syncLauncherAutostart 把启动器自启状态同步为与应用一致；状态或路径有变化时返回 true 并记录日志。
func syncLauncherAutostart(path string) bool {
	h, err := regOpenRunKey(regAccessRead | regAccessWrite)
	if err != nil {
		logger.Printf("同步开机自启失败：无法打开 Run 键: %v", err)
		return false
	}
	defer procRegCloseKey.Call(h)

	appOn := regValueExists(h, regAppValue)
	existing, launcherOn := regQueryString(h, regLchValue)

	// 应用关闭自启 → 删除启动器自启项
	if !appOn && launcherOn {
		regDeleteValue(h, regLchValue)
		logger.Printf("应用已关闭开机自启，启动器自启已同步关闭")
		return true
	}

	// 应用开启自启 → 确保启动器自启项存在，且路径指向 GUI 版（顺带修复历史指向 console 版的残留）
	if appOn && (!launcherOn || existing != `"`+path+`"`) {
		regSetString(h, regLchValue, `"`+path+`"`)
		logger.Printf("应用已开启开机自启，启动器自启已同步开启")
		return true
	}

	return false
}

// launcherAutostartPath 返回要写入自启项的路径：始终是 GUI 版 KeyStatsLauncher.exe，
// 即使当前运行的是控制台版也替换为同目录下的 GUI 版，避免登录时弹控制台窗口。
func launcherAutostartPath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	p, _ = filepath.Abs(p)
	if filepath.Base(p) == "KeyStatsLauncher-console.exe" {
		p = filepath.Join(filepath.Dir(p), "KeyStatsLauncher.exe")
	}
	return p
}
