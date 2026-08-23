# 构建 KeyStatsLauncher.exe（无控制台窗口），输出到 dist/
param(
    [string]$Name = "KeyStatsLauncher"
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 优先使用项目内工具链（.toolchain\go），否则用 PATH 中的 go
$goExe = Join-Path $root ".toolchain\go\bin\go.exe"
if (Test-Path $goExe) {
    $env:GOCACHE = Join-Path $root ".toolchain\cache"
    $env:GOPATH = Join-Path $root ".toolchain\gopath"
} else {
    $goExe = "go"
}

# 纯标准库实现（本地绑定页），无需 C 编译器，禁用 cgo 保证可移植
$env:CGO_ENABLED = "0"

# -H windowsgui：不弹控制台窗口；-s -w：去掉符号表与调试信息，缩小体积
& $goExe build -trimpath -ldflags "-H windowsgui -s -w" -o (Join-Path $outDir "$Name.exe") .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# 控制台版本：用于执行 --install-autostart / --remove-autostart / 调试
& $goExe build -trimpath -ldflags "-s -w" -o (Join-Path $outDir "$Name-console.exe") .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $outDir "config.json"))) {
    Copy-Item (Join-Path $root "config.json") (Join-Path $outDir "config.json")
}
if (-not (Test-Path (Join-Path $outDir "App/KeyStats.exe"))) {
    Write-Host "提示: 请把 KeyStats.exe 放到 $outDir/App 目录（或修改 config.json 的 keyStatsExe）"
}

Write-Host "构建完成: $(Join-Path $outDir "$Name.exe") / $(Join-Path $outDir "$Name-console.exe")"
