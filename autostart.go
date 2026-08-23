package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// 开机自启：写入 HKCU 注册表 Run 键（免管理员权限，登录即启动）。
const runKeyPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func installAutostart() int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Println("获取程序路径失败:", err)
		return 1
	}
	exe, _ = filepath.Abs(exe)

	cmd := exec.Command("reg.exe", "add", runKeyPath, "/v", "KeyStatsLauncher", "/t", "REG_SZ", "/d", exe, "/f")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Println("开启开机自启失败:", err, string(out))
		return 1
	}
	fmt.Println("已开启开机自启:", exe)
	return 0
}

func removeAutostart() int {
	cmd := exec.Command("reg.exe", "delete", runKeyPath, "/v", "KeyStatsLauncher", "/f")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Println("关闭开机自启失败:", err, string(out))
		return 1
	}
	fmt.Println("已关闭开机自启")
	return 0
}
