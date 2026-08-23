package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// bindState 由 HTTP 处理与轮询协程共享的绑定状态。
type bindState struct {
	mu        sync.Mutex
	code      string
	expiresAt time.Time
	bound     bool
	online    bool // 后端注册/刷新是否成功
	sb        *Supabase
	uuid      string // 设备 uuid（注册后持有）
	secret    string // 设备密钥
	cfgPath   string
}

// genCode 生成新的 6 位验证码并同步到后端：
//   - 尚未注册则 registerDevice 并从后端取得 uuid/secret；
//   - 已注册则 refreshCode 作废旧码换新码。
// 成功后更新 st.code / st.expiresAt / st.uuid / st.secret 并持久化；失败标记 online=false。
func genCode(st *bindState) {
	st.mu.Lock()
	defer st.mu.Unlock()

	cfg := LoadConfig(st.cfgPath)
	sb := newSupabase(cfg)
	newCode := randomToken(6)

	if st.uuid == "" || st.secret == "" {
		st.secret = randomToken(32)
		u, err := sb.registerDevice(newCode, st.secret)
		if err != nil {
			logger.Printf("注册设备失败: %v", err)
			st.online = false
			return
		}
		st.uuid = u
		dev := LoadDeviceConfig()
		dev.DeviceUUID, dev.DeviceSecret = st.uuid, st.secret
		writeDeviceConfig(dev)
	} else {
		ok, err := sb.refreshCode(st.uuid, st.secret, newCode)
		if err != nil {
			logger.Printf("刷新验证码失败: %v", err)
			st.online = false
			return
		}
		if !ok {
			logger.Printf("设备无效，请删除安装目录 config.json 后重试")
			st.online = false
			return
		}
	}

	st.code = newCode
	st.expiresAt = time.Now().Add(5 * time.Minute)
	st.online = true
	st.sb = sb
}

// runBindWindow 在设备未绑定时启动本地绑定服务：
//   - 生成 6 位验证码并注册/刷新到后端，保存设备 uuid/secret；
//   - 启动 127.0.0.1 随机端口 HTTP 服务，用默认浏览器打开绑定页；
//   - 页面轮询 /status，可手动 /refresh 重新发送（作废旧码换新码）；
//   - 网页端绑定成功后写入 isBound，延时 3 秒关闭服务。
func runBindWindow(cfgPath string) {
	st := &bindState{cfgPath: cfgPath}
	genCode(st)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { serveIndex(w, st) })
	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) { serveStatus(w, st) })
	mux.HandleFunc("/refresh", func(w http.ResponseWriter, _ *http.Request) { genCode(st); serveStatus(w, st) })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Printf("启动本地绑定服务失败: %v", err)
		return
	}
	port := ln.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(ln) }()

	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	openBrowser(url)
	logger.Printf("绑定窗口已打开: %s", url)

	// 轮询绑定状态，直到绑定/超时（验证码有效期 5 分钟，多留 1 分钟容错）
	deadline := time.Now().Add(6 * time.Minute)
	for {
		st.mu.Lock()
		bound := st.bound
		uuid, secret := st.uuid, st.secret
		st.mu.Unlock()

		if bound {
			break
		}
		if time.Now().After(deadline) {
			logger.Printf("验证码已过期，本轮绑定结束")
			break
		}
		st.mu.Lock()
		sb := st.sb
		st.mu.Unlock()
		db, err := sb.deviceBound(uuid, secret)
		if err != nil {
			logger.Printf("查询绑定状态失败: %v", err)
			// 短暂间隔后重试
		} else if db {
			dev := LoadDeviceConfig()
			dev.IsBound = true
			writeDeviceConfig(dev)
			st.mu.Lock()
			st.bound = true
			st.mu.Unlock()
			logger.Printf("设备绑定成功")
			time.Sleep(3 * time.Second) // 显示成功结果 3 秒
			break
		}
		time.Sleep(2 * time.Second)
	}
	_ = server.Close()
}

// serveStatus 返回 JSON 状态供页面轮询（含过期时间戳，前端据此倒计时）。
func serveStatus(w http.ResponseWriter, st *bindState) {
	st.mu.Lock()
	s := struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expiresAt"` // Unix 毫秒；0 表示未知
		Bound     bool   `json:"bound"`
		Online    bool   `json:"online"`
	}{st.code, st.expiresAt.UnixMilli(), st.bound, st.online}
	st.mu.Unlock()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(s)
}

// openBrowser 用系统默认浏览器打开指定地址。
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		logger.Printf("打开浏览器失败: %v", err)
	}
}

const indexHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>设备绑定 · 手护</title>
<style>
  :root {
    --bg:#f5f6f8; --surface:#ffffff; --line:#e4e7ec;
    --text:#14161a; --text-2:#5b6470; --primary:#2f6fed;
    --primary-soft:#e8f0fe; --success:#2f9e6e; --danger:#d64545;
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:var(--text);font-size:14px;-webkit-font-smoothing:antialiased}
  .card{width:400px;background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:32px 28px;text-align:center;box-shadow:0 1px 3px rgba(16,24,40,.06)}
  .mark{color:var(--primary);margin-bottom:10px}
  h1{font-size:18px;margin:0 0 6px}
  .sub{color:var(--text-2);margin:0 0 22px}
  .code{font:600 44px/1.1 Consolas,Menlo,ui-monospace,monospace;display:flex;justify-content:space-between;
    gap:6px;color:var(--primary);
    background:var(--primary-soft);border-radius:12px;padding:16px 18px;margin:0 0 12px}
  .code span{flex:1;text-align:center}
  .hint{color:var(--text-2);font-size:12px;margin:0 0 8px}
  .countdown{font-variant-numeric:tabular-nums;font-size:13px;color:var(--text-2);margin:0 0 16px}
  .countdown.expiring{color:var(--danger)}
  .btn{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--text);
    padding:9px 20px;border-radius:8px;margin-top:4px}
  .btn:hover{background:var(--surface-2,#f0f2f5)}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .status{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-2);margin-top:16px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--primary);animation:blink 1.2s infinite}
  @keyframes blink{50%{opacity:.3}}
  .ok{color:var(--success);font-weight:600}
  .ok .dot{background:var(--success);animation:none}
  .err{color:var(--danger)}
  .expired-box{position:absolute;inset:0;display:none}
</style>
</head>
<body>
  <div class="card">
    <svg class="mark" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14l1.6-5.2A2 2 0 0 1 7.5 7.4c.8 0 1.5.4 1.9 1.1L11 11V4.5C11 3.7 11.7 3 12.5 3S14 3.7 14 4.5V11h.5c.6 0 1.1.2 1.5.6l2-3.1c.3-.5.9-.7 1.4-.5.6.2 1 .8.9 1.4L19 13a6 6 0 0 1-6 5h-2a6 6 0 0 1-5-2.8L4 14z"/></svg>
    <h1 id="title">绑定你的设备</h1>
    <p class="sub" id="cap">在网页「绑定设备」页输入下方验证码</p>
    <div class="code" id="code">······</div>
    <p class="hint">验证码 5 分钟内有效，过期可点击下方重新发送</p>
    <p class="countdown" id="countdown"></p>
    <button class="btn" id="refreshBtn">重新发送验证码</button>
    <div class="status"><span class="dot" id="dot"></span><span id="status">正在连接…</span></div>
  </div>
<script>
  function pad(n){return n<10?'0'+n:''+n}
  function mmss(ms){
    if(ms<0) return '00:00';
    const s=Math.floor(ms/1000), m=Math.floor(s/60);
    return pad(m)+':'+pad(s%60);
  }
  function render(s){
    const code=document.getElementById('code');
    const status=document.getElementById('status');
    const dot=document.getElementById('dot');
    const title=document.getElementById('title');
    const cap=document.getElementById('cap');
    const cd=document.getElementById('countdown');
    const btn=document.getElementById('refreshBtn');
    if(s.online === false){
      title.textContent='绑定页暂不可用';
      cap.textContent='启动器未能连接绑定服务，请重新发送或重启启动器重试。';
      code.style.display='none'; cd.style.display='none'; btn.style.display='none';
      status.textContent='离线'; dot.classList.add('err'); status.classList.add('err');
      stop(); return;
    }
    if(s.bound){
      title.textContent='绑定成功';
      cap.textContent='设备已关联到你的账号，此页面可关闭。';
      code.textContent='✓'; code.style.letterSpacing='0';
      cd.style.display='none'; btn.style.display='none';
      status.textContent='3 秒后自动关闭';
      dot.classList.add('ok'); status.classList.add('ok');
      setTimeout(()=>{ try{window.close()}catch(e){} document.body.innerHTML='<div style="margin:40px;color:var(--text-2);text-align:center">绑定成功，此页面可关闭</div>'; },3000);
      stop(); return;
    }
    // 正常态：显示验证码（每字符一个 span，均匀分布） + 倒计时（整秒刷新）
    code.style.display='';
    code.innerHTML=s.code.split('').map(function(c){return '<span>'+c+'</span>';}).join('');
    btn.style.display='';
    const remain=s.expiresAt-Date.now();
    if(remain<=0){
      cd.textContent='验证码已过期，请点击下方重新发送';
      cd.classList.add('expiring');
      status.textContent='已过期';
      dot.classList.add('err'); status.classList.add('err');
    }else{
      cd.textContent='有效剩余 '+mmss(remain);
      cd.classList.remove('expiring');
      status.textContent='等待网页端绑定…';
      dot.classList.remove('err'); status.classList.remove('err');
    }
  }
  function stop(){ render._run=false; }
  // tick 轮询 /status 并刷新页面；页面应关闭或绑定完成时停止。
  async function tick(){
    if(!render._run) return;
    try{
      const r=await fetch('/status');
      render(await r.json());
    }catch(e){
      document.getElementById('status').textContent='连接本地服务失败';
      document.getElementById('status').classList.add('err');
      document.getElementById('dot').classList.add('err');
    }
  }
  document.getElementById('refreshBtn').addEventListener('click', async function(){
    this.disabled=true;
    const btn=this;
    try{
      const r=await fetch('/refresh');
      render(await r.json());
      setTimeout(()=>{btn.disabled=false;},800);
    }catch(e){
      btn.disabled=false;
      document.getElementById('status').textContent='重新发送失败，请重试';
      document.getElementById('status').classList.add('err');
      document.getElementById('dot').classList.add('err');
    }
  });
  render._run=true;
  tick();
  setInterval(tick, 1000);
</script></body>
</html>`

// serveIndex 写入绑定页面。
func serveIndex(w http.ResponseWriter, _ *bindState) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(indexHTML))
}
