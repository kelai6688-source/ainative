# start-detached.ps1 — 把看门狗/服务从「当前终端会话」里剥离出去
#
# 为什么需要它：从编辑器/终端里 Start-Process 出来的进程属于这个终端的 Job 对象，
# 终端一关、任务一结束，Windows 会把整棵树一起干掉 —— 表现就是「指挥台自己关了，
# 看门狗也没了，没人重启」。用 WMI 的 Win32_Process.Create 由 WmiPrvSE 托管创建，
# 不挂在任何终端 Job 下，终端关了它还在。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-detached.ps1
#
# 幂等：已有 keepalive 在跑就不再起第二个。

$ErrorActionPreference = "SilentlyContinue"
$root = "{{ROOT}}"
$node = "C:\Program Files\nodejs\node.exe"

function Has-Keepalive {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*keepalive.mjs*" -and $_.CommandLine -notlike "*runner.js*" }
  return [bool]$p
}

if (Has-Keepalive) {
  "keepalive already running"
} else {
  $cmd = "cmd.exe /c cd /d `"$root`" && `"$node`" keepalive.mjs >> logs\keepalive-wmi.log 2>&1"
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  if ($r.ReturnValue -eq 0) { "keepalive spawned (cmd pid $($r.ProcessId))" }
  else { "spawn failed: $($r.ReturnValue)" }
}

# 给它 8 秒把服务/泵拉起来
Start-Sleep -Seconds 8
$up = [bool](Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue)
"server: $(if ($up) { 'UP' } else { 'DOWN' })"
