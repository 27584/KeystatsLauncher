package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// DailyStats 与 KeyStats 的 daily_stats.json / history.json 结构对应。
// AppStats 字段仅用于解析识别，上传时明确剔除（不入库）。
type DailyStats struct {
	Date              string         `json:"date"`
	KeyPresses        int            `json:"keyPresses"`
	KeyPressCounts    map[string]int `json:"keyPressCounts"`
	LeftClicks        int            `json:"leftClicks"`
	RightClicks       int            `json:"rightClicks"`
	MiddleClicks      int            `json:"middleClicks"`
	SideBackClicks    int            `json:"sideBackClicks"`
	SideForwardClicks int            `json:"sideForwardClicks"`
	MouseDistance     float64        `json:"mouseDistance"`
	ScrollDistance    float64        `json:"scrollDistance"`
	PeakKPS           float64        `json:"peakKPS"`
	PeakCPS           float64        `json:"peakCPS"`
	AppStats          map[string]any `json:"appStats"`
}

func localAppData() string {
	if p := os.Getenv("LOCALAPPDATA"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local")
}

// readDailyStats 读取 KeyStats 当日数据。
func readDailyStats(dataDir string) (*DailyStats, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, "daily_stats.json"))
	if err != nil {
		return nil, err
	}
	var s DailyStats
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// uploadOnce 执行一次上传：读取当日数据，剔除 appStats，带设备 uuid 与密钥上传。
// 仅当设备已绑定（dev.IsBound=true 且已持有 uuid/secret）时才联网上传。
func uploadOnce(cfg Config, dev DeviceConfig, exeDir string) error {
	if !dev.IsBound || dev.DeviceUUID == "" || dev.DeviceSecret == "" {
		return nil // 未绑定，跳过
	}
	if cfg.SupabaseURL == "" || cfg.PublishableKey == "" {
		return fmt.Errorf("未配置 Supabase 服务地址或公钥")
	}

	dataDir := Resolve(exeDir, cfg.DataDir)
	if dataDir == "" {
		dataDir = filepath.Join(localAppData(), "KeyStats")
	}

	today, err := readDailyStats(dataDir)
	if err != nil {
		return fmt.Errorf("读取当日数据失败: %w", err)
	}

	sb := newSupabase(cfg)
	return sb.uploadSnapshot(*today, dev.DeviceUUID, dev.DeviceSecret)
}
