package main

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
)

// Config 控制启动器运行参数，读取 exe 同目录下的 config.json。
// 绑定状态（is_bound / uuid / device_secret）不在此文件，单独存
// %LOCALAPPDATA%\KeyStatsUploader\config.json（见 DeviceConfig）。
type Config struct {
	// KeyStatsExe 要启动的 KeyStats 程序路径；相对路径基于启动器所在目录解析
	KeyStatsExe string `json:"keyStatsExe"`
	// UploadIntervalMinutes 上传间隔（分钟）
	UploadIntervalMinutes int `json:"uploadIntervalMinutes"`
	// SupabaseURL 数据 API 基地址（形如 https://xxxx.supabase.co）
	SupabaseURL string `json:"supabaseUrl"`
	// PublishableKey 新版 Publishable Key（anon 角色），用于鉴权调用 RPC
	PublishableKey string `json:"publishableKey"`
	// DataDir KeyStats 数据目录；留空则为 %LOCALAPPDATA%\KeyStats
	DataDir string `json:"dataDir"`
}

func DefaultConfig() Config {
	return Config{
		KeyStatsExe:           "KeyStats.exe",
		UploadIntervalMinutes: 5,
		SupabaseURL:           "",
		PublishableKey:        "",
		DataDir:               "",
	}
}

// DeviceConfig 设备绑定状态，读取/写入 %LOCALAPPDATA%\KeyStatsUploader\config.json，
// 与程序目录 config.json（运行参数）相互独立，避免更新程序时被覆盖。
type DeviceConfig struct {
	// IsBound 设备是否已绑定到用户；未绑定则每次启动显示绑定窗口
	IsBound bool `json:"is_bound"`
	// DeviceUUID 设备标识，注册时由后端生成、此处保存
	DeviceUUID string `json:"uuid"`
	// DeviceSecret 设备密钥，本地生成并保存，上传时用于鉴权
	DeviceSecret string `json:"device_secret"`
}

func DefaultDeviceConfig() DeviceConfig {
	return DeviceConfig{}
}

// deviceConfigPathFn 返回绑定状态文件路径（%LOCALAPPDATA%\KeyStatsUploader\config.json）。
// 包级变量便于测试重定向到临时目录；默认实现见下。
var deviceConfigPath = func() string {
	return filepath.Join(localAppData(), "KeyStatsUploader", "config.json")
}

// LoadConfig 读取并解析运行参数 config.json；文件不存在或解析失败时使用默认值并落盘默认配置。
func LoadConfig(path string) Config {
	cfg := DefaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeConfig(path, cfg)
		} else {
			logger.Printf("读取 %s 失败: %v，使用默认配置", path, err)
		}
		return cfg
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		logger.Printf("解析 %s 失败: %v，使用默认配置", path, err)
		return DefaultConfig()
	}
	return cfg
}

// LoadDeviceConfig 读取并解析绑定状态文件；文件不存在或解析失败时使用默认值（未绑定）。
func LoadDeviceConfig() DeviceConfig {
	return loadDeviceConfigAt(deviceConfigPath())
}

// loadDeviceConfigAt path 版本的内部实现；path 为空则按未绑定处理。
func loadDeviceConfigAt(path string) DeviceConfig {
	dev := DefaultDeviceConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Printf("读取 %s 失败: %v，按未绑定处理", path, err)
		}
		return dev
	}
	if err := json.Unmarshal(data, &dev); err != nil {
		logger.Printf("解析 %s 失败: %v，按未绑定处理", path, err)
		return DefaultDeviceConfig()
	}
	return dev
}

// writeConfig 将运行参数写入磁盘。
func writeConfig(path string, cfg Config) {
	writeJSONFile(path, cfg)
}

// writeDeviceConfig 将绑定状态写入 %LOCALAPPDATA%\KeyStatsUploader\config.json，
// 目录不存在时先创建。
func writeDeviceConfig(dev DeviceConfig) {
	path := deviceConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logger.Printf("创建 %s 目录失败: %v", filepath.Dir(path), err)
		return
	}
	writeJSONFile(path, dev)
}

// writeJSONFile 将对象序列化写入指定路径。
func writeJSONFile(path string, v any) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		logger.Printf("写入文件 %s 失败: %v", path, err)
	}
}

// randomToken 生成 n 位随机码，字符集为大写字母与数字，用于绑定验证码。
func randomToken(n int) string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去除易混淆的 I/O/0/1
	buf := make([]byte, n)
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		// 一般不发生；退化为固定值可保窗口可用，但按严谨要求直接返回空并在上层报错更妥当
		return ""
	}
	for i := 0; i < n; i++ {
		buf[i] = alphabet[int(raw[i])%len(alphabet)]
	}
	return string(buf)
}

// Resolve 将配置中的相对路径基于 baseDir 解析为绝对路径；空路径返回空字符串。
func Resolve(baseDir, p string) string {
	if p == "" {
		return ""
	}
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(baseDir, p)
}
