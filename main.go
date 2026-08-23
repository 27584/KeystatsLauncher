package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var logger *log.Logger

func main() {
	// 开机自启管理子命令（用控制台版本运行，可看到输出）
	if len(os.Args) == 2 {
		switch os.Args[1] {
		case "--install-autostart":
			os.Exit(installAutostart())
		case "--remove-autostart":
			os.Exit(removeAutostart())
		}
	}

	logFile, err := setupLogger()
	if err != nil {
		logger = log.New(os.Stderr, "", log.LstdFlags)
	} else {
		defer logFile.Close()
	}

	// 单实例：避免重复双击导致多个绑定窗口/上传循环
	if !lockSingleInstance("KeyStatsLauncher") {
		logger.Printf("已有一个启动器实例在运行，本实例退出")
		return
	}
	defer unlockSingleInstance()

	exeDir, err := os.Executable()
	if err != nil {
		logger.Printf("获取程序路径失败: %v", err)
		return
	}
	exeDir = filepath.Dir(exeDir)
	cfgPath := filepath.Join(exeDir, "config.json")
	cfg := LoadConfig(cfgPath)
	dev := LoadDeviceConfig()

	keyStatsPath := Resolve(exeDir, cfg.KeyStatsExe)
	if keyStatsPath == "" {
		logger.Printf("未配置 keyStatsExe，退出")
		return
	}

	cmd := exec.Command(keyStatsPath)
	cmd.Dir = exeDir
	if err := cmd.Start(); err != nil {
		logger.Printf("启动 KeyStats 失败: %v（请确认 %s 存在）", err, keyStatsPath)
		return
	}
	logger.Printf("已启动 KeyStats: %s", keyStatsPath)

	// KeyStats 可能因单实例等原因提前退出；上传器保持常驻，不随其退出
	go func() {
		cmd.Wait()
		logger.Printf("KeyStats 进程已退出，上传器继续常驻运行")
	}()

	// 开机自启跟随：应用开自启则启动器开自启，反之亦然；启动时同步一次并定时轮询
	if launcherPath := launcherAutostartPath(); launcherPath != "" {
		syncLauncherAutostart(launcherPath)
		go func() {
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for range t.C {
				syncLauncherAutostart(launcherPath)
			}
		}()
	}

	startScheduler(cfgPath, cfg.UploadIntervalMinutes, exeDir)

	// 未绑定则启动本地绑定页（阻塞至绑定成功或用户关闭）
	if !dev.IsBound {
		logger.Printf("设备未绑定，启动绑定页")
		runBindWindow(cfgPath)
		// 返回主循环；绑定成功即会上传，未绑定则下个上传周期继续跳过
	}

	// 常驻保持进程存活，上传调度在后台 goroutine 中运行
	select {}
}

// startScheduler 后台定时上传循环；每次上传前读取最新配置以获取绑定状态。
func startScheduler(cfgPath string, intervalMin int, exeDir string) {
	interval := time.Duration(intervalMin) * time.Minute
	if interval <= 0 {
		interval = 5 * time.Minute
	}

	doUpload := func() {
		cfg := LoadConfig(cfgPath) // 读取最新运行参数
		dev := LoadDeviceConfig()  // 读取最新 is_bound/uuid/secret
		if err := uploadOnce(cfg, dev, exeDir); err != nil {
			logger.Printf("上传失败: %v", err)
		} else if dev.IsBound {
			logger.Printf("上传成功")
		}
	}

	go func() {
		doUpload() // 启动后立即上传一次
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			doUpload()
		}
	}()
}

// setupLogger 日志写入 %LOCALAPPDATA%\KeyStatsUploader\launcher.log
func setupLogger() (*os.File, error) {
	dir := filepath.Join(localAppData(), "KeyStatsUploader")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	logger = log.New(f, "", log.LstdFlags)
	return f, nil
}
