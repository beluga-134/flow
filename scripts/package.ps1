[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $ProjectRoot

$Npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$Cargo = Get-Command cargo.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Npm) { throw 'npm.cmd was not found. Install Node.js or add it to PATH.' }
if (-not $Cargo) { throw 'cargo.exe was not found. Install the Rust MSVC toolchain or add it to PATH.' }

& $Npm.Source install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $Npm.Source run tauri -- build --no-bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Metadata = & $Cargo.Source metadata --format-version 1 --no-deps --manifest-path (Join-Path $ProjectRoot 'src-tauri\Cargo.toml') | ConvertFrom-Json
$BuiltExecutable = Join-Path $Metadata.target_directory 'release\flow-canvas.exe'
if (-not (Test-Path -LiteralPath $BuiltExecutable -PathType Leaf)) {
    throw "Built executable was not found: $BuiltExecutable"
}

$ReleaseDirectory = Join-Path $ProjectRoot 'release'
$ReleaseExecutable = Join-Path $ReleaseDirectory 'Flow Canvas.exe'
New-Item -ItemType Directory -Path $ReleaseDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltExecutable -Destination $ReleaseExecutable -Force

$SizeMb = [Math]::Round((Get-Item -LiteralPath $ReleaseExecutable).Length / 1MB, 1)
Write-Host "Packaged executable: $ReleaseExecutable ($SizeMb MB)"
