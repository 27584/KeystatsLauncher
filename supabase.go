package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Supabase 通过新版 Publishable Key（anon 角色）调用 /rest/v1/rpc/<func>，
// 鉴权方式与前端 supabase-js 一致：apikey + Authorization: Bearer。
type Supabase struct {
	base string
	key  string
}

func newSupabase(cfg Config) *Supabase {
	return &Supabase{base: strings.TrimRight(cfg.SupabaseURL, "/"), key: cfg.PublishableKey}
}

// call 调用单个 RPC 函数；params 序列化到请求体，out 解析响应（可为 nil）。
func (s *Supabase) call(name string, params map[string]any, out any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, s.base+"/rest/v1/rpc/"+name, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("apikey", s.key)
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("User-Agent", "KeyStats-Windows/1")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("RPC %s 返回 HTTP %d: %s", name, resp.StatusCode, truncate(string(data), 200))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// deviceName 上报设备名称供网页端展示，取本机主机名；取不到用固定占位。
func deviceName() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "未命名设备"
}

// registerDevice 注册设备（启动器未绑定时调用），返回后端生成的设备 uuid。
func (s *Supabase) registerDevice(code, secret string) (string, error) {
	var uuid string
	if err := s.call("register_device", map[string]any{
		"p_bind_code":     code,
		"p_device_secret": secret,
		"p_device_name":   deviceName(),
	}, &uuid); err != nil {
		return "", err
	}
	return uuid, nil
}

// refreshCode 为已注册但未绑定的设备更换验证码（避免重复注册产生多余设备行）。
func (s *Supabase) refreshCode(uuid, secret, code string) (bool, error) {
	var ok bool
	if err := s.call("refresh_bind_code", map[string]any{
		"p_device_uuid":   uuid,
		"p_device_secret": secret,
		"p_bind_code":     code,
	}, &ok); err != nil {
		return false, err
	}
	return ok, nil
}

// deviceBound 查询指定设备是否已绑定（绑定窗口轮询用）。
func (s *Supabase) deviceBound(uuid, secret string) (bool, error) {
	var bound bool
	if err := s.call("get_device_status", map[string]any{
		"p_device_uuid":   uuid,
		"p_device_secret": secret,
	}, &bound); err != nil {
		return false, err
	}
	return bound, nil
}

// uploadSnapshot 上传一条健康快照（仅绑定后调用；数据已剔除 appStats）。
func (s *Supabase) uploadSnapshot(d DailyStats, uuid, secret string) error {
	params := map[string]any{
		"p_device_uuid":         uuid,
		"p_device_secret":       secret,
		"p_device_name":         deviceName(),
		"p_stats_date":          d.Date[:10], // yyyy-mm-dd
		"p_key_presses":         d.KeyPresses,
		"p_key_press_counts":    d.KeyPressCounts,
		"p_left_clicks":         d.LeftClicks,
		"p_right_clicks":        d.RightClicks,
		"p_middle_clicks":       d.MiddleClicks,
		"p_side_back_clicks":    d.SideBackClicks,
		"p_side_forward_clicks": d.SideForwardClicks,
		"p_mouse_distance":      d.MouseDistance,
		"p_scroll_distance":     d.ScrollDistance,
		"p_peak_kps":            d.PeakKPS,
		"p_peak_cps":            d.PeakCPS,
	}
	return s.call("upload_snapshot", params, nil)
}
