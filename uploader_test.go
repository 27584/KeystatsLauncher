package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadDailyStats 验证对真实 KeyStats 当日数据的解析（testdata/daily_stats.json）。
func TestReadDailyStats(t *testing.T) {
	s, err := readDailyStats("testdata")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if s.Date[:10] != "2026-08-18" {
		t.Fatalf("日期切割错误: %q", s.Date)
	}
	if s.KeyPresses != 1520 {
		t.Fatalf("KeyPresses = %d, want 1520", s.KeyPresses)
	}
	if s.PeakKPS != 8.5 {
		t.Fatalf("PeakKPS = %v, want 8.5", s.PeakKPS)
	}
	// appStats 应能解析（上传时不会被发送，见 uploadSnapshot）
	if len(s.AppStats) == 0 {
		t.Fatal("appStats 应被解析出来")
	}
}

// TestConfigRoundTrip 验证运行参数写入/读取一致。
func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	// 初始不存在 → 写默认配置
	cfg := LoadConfig(path)
	if cfg.UploadIntervalMinutes != 5 {
		t.Fatalf("UploadIntervalMinutes = %d, want 5", cfg.UploadIntervalMinutes)
	}
	if !FileExists(path) {
		t.Fatal("应已生成默认 config.json")
	}

	// 修改并写回后再读
	cfg.KeyStatsExe = "App/KeyStats.exe"
	cfg.UploadIntervalMinutes = 10
	writeConfig(path, cfg)

	got := LoadConfig(path)
	if got.UploadIntervalMinutes != 10 || got.KeyStatsExe != cfg.KeyStatsExe {
		t.Fatalf("配置不一致: %+v", got)
	}
}

// TestDeviceConfigRoundTrip 验证绑定状态独立读写，且新设备默认未绑定。
func TestDeviceConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	oldPathFn := deviceConfigPath
	// 将绑定状态文件重定向到临时目录，避免污染真实 %LOCALAPPDATA%
	deviceConfigPath = func() string { return path }
	defer func() { deviceConfigPath = oldPathFn }()

	// 初始不存在 → 默认未绑定
	dev := LoadDeviceConfig()
	if dev.IsBound {
		t.Fatal("新设备应默认未绑定")
	}
	if dev.DeviceUUID != "" || dev.DeviceSecret != "" {
		t.Fatal("新设备不应持有 uuid/secret")
	}

	// 写回后再读
	dev.IsBound = true
	dev.DeviceUUID = "11111111-2222-3333-4444-555555555555"
	dev.DeviceSecret = "secret"
	writeDeviceConfig(dev)

	got := LoadDeviceConfig()
	if !got.IsBound || got.DeviceUUID != dev.DeviceUUID || got.DeviceSecret != dev.DeviceSecret {
		t.Fatalf("绑定状态不一致: %+v", got)
	}
}

// TestRandomToken 验证验证码长度与字符集（大写字母+数字，且规避易混淆字符）。
func TestRandomToken(t *testing.T) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for i := 0; i < 50; i++ {
		tok := randomToken(6)
		if len(tok) != 6 {
			t.Fatalf("长度=%d", len(tok))
		}
		for _, c := range tok {
			if !strings.ContainsRune(alphabet, c) {
				t.Fatalf("非法字符 %q", c)
			}
		}
	}
}

func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}