# 저장소 최상단의 실행용 exe 세 개를 Launcher.cs에서 다시 빌드한다 -- 2026-11-01
# Windows 기본 .NET Framework 4 컴파일러를 쓰므로 따로 설치할 것이 없다.
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1

$ErrorActionPreference = "Stop"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$src = Join-Path $PSScriptRoot "Launcher.cs"
$root = Split-Path $PSScriptRoot -Parent

$targets = @(
    @{ Define = "API_SERVER"; Out = "API서버_실행.exe" },
    @{ Define = "ROBOT_DOOR"; Out = "로봇실연동_문탐지_실행.exe" },
    @{ Define = "ROBOT_BOX"; Out = "로봇실연동_박스탐지_실행.exe" }
)

foreach ($t in $targets) {
    $out = Join-Path $root $t.Out
    & $csc /nologo /codepage:65001 /target:exe /optimize+ "/define:$($t.Define)" "/out:$out" $src
    if ($LASTEXITCODE -ne 0) { throw "빌드 실패: $($t.Out)" }
    Write-Host "빌드: $out"
}
