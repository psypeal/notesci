#requires -Version 5.1
<#
.SYNOPSIS
    Build pgvector 0.8.0 on Windows with MSVC against a relocated/extracted
    EnterpriseDB PostgreSQL 16.4 windows-x64 binary tree (PGROOT).

.DESCRIPTION
    Self-bootstraps the x64 MSVC build environment (vcvars64 / Enter-VsDevShell
    located via vswhere), then runs `nmake /F Makefile.win` and
    `nmake /F Makefile.win install`. pgvector's Makefile.win derives every path
    from $env:PGROOT (bin/include/lib/share) and never touches the registry or
    an installer, so an extracted, relocatable EDB tree works fine.

    On `install` the artifacts land, relative to PGROOT:
        vector.dll       -> $PGROOT\lib                (PKGLIBDIR)
        vector.control   -> $PGROOT\share\extension
        vector--*.sql    -> $PGROOT\share\extension
        *.h (server hdrs)-> $PGROOT\include\server\extension\vector

.PARAMETER PgRoot
    Path to the extracted PostgreSQL tree. Must contain bin\, include\, lib\,
    share\. For a Tauri resource staging tree this is e.g.
    desktop\src-tauri\resources\pg.

.PARAMETER PgvectorRef
    Git tag/branch to build. Default v0.8.0.

.PARAMETER WorkDir
    Scratch dir for the clone. Default $env:TEMP\pgvector-build.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File build-pgvector-win.ps1 `
        -PgRoot "C:\src\notesci\desktop\src-tauri\resources\pg"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PgRoot,

    [string] $PgvectorRef = 'v0.8.0',

    [string] $WorkDir = (Join-Path $env:TEMP 'pgvector-build')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 1. Resolve & validate PGROOT (relocated EDB tree, no registry needed)
# ---------------------------------------------------------------------------
$PgRoot = (Resolve-Path -LiteralPath $PgRoot).Path
Write-Step "PGROOT = $PgRoot"

foreach ($sub in @('bin', 'include', 'lib', 'share')) {
    $p = Join-Path $PgRoot $sub
    if (-not (Test-Path -LiteralPath $p)) {
        throw "PGROOT is missing '$sub\'. Expected an extracted EDB binary tree (bin/include/lib/share) at '$PgRoot'."
    }
}
# Makefile.win links against $(PGROOT)\lib\postgres.lib and includes
# $(PGROOT)\include\server. Fail fast with a clear message if absent.
$postgresLib = Join-Path $PgRoot 'lib\postgres.lib'
$serverInc   = Join-Path $PgRoot 'include\server\postgres.h'
if (-not (Test-Path -LiteralPath $postgresLib)) {
    throw "Missing '$postgresLib'. The EDB *binaries* zip (not the installer-only payload) includes lib\postgres.lib and include\server\*."
}
if (-not (Test-Path -LiteralPath $serverInc)) {
    throw "Missing '$serverInc'. Server headers (include\server\) are required to compile pgvector."
}

# pgvector's Makefile.win reads PGROOT from the environment.
$env:PGROOT = $PgRoot

# ---------------------------------------------------------------------------
# 2. Self-bootstrap the x64 MSVC environment (vcvars64) if not already active
# ---------------------------------------------------------------------------
# pgvector requires the x64 toolchain. If nmake + a 64-bit cl are already on
# PATH (e.g. script launched from "x64 Native Tools Command Prompt"), reuse it;
# otherwise locate VS via vswhere and import vcvars64.bat into this session.
function Test-X64ToolchainActive {
    $nmake = Get-Command nmake.exe -ErrorAction SilentlyContinue
    if (-not $nmake) { return $false }
    # VSCMD_ARG_TGT_ARCH is set by vcvars/VsDevShell; confirm it's x64.
    if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne 'x64') { return $false }
    return $true
}

function Import-VcVars64Environment {
    Write-Step 'Locating Visual Studio via vswhere'

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw "vswhere.exe not found at '$vswhere'. Install Visual Studio 2017+ with the 'Desktop development with C++' workload, or run this from an x64 Native Tools Command Prompt."
    }

    # Require the x64/x86 VC toolset component so we don't pick a VS instance
    # that lacks the C++ build tools.
    $vsPath = & $vswhere -latest -prerelease `
        -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if (-not $vsPath) {
        throw "No Visual Studio instance with the x64 C++ toolset (Microsoft.VisualStudio.Component.VC.Tools.x86.x64) was found."
    }
    $vsPath = $vsPath.Trim()
    Write-Step "Visual Studio: $vsPath"

    # Preferred path: vcvars64.bat -> dump env -> import into this session.
    # This is the most robust way to get an x64-targeting, x64-host toolchain.
    $vcvars64 = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
    if (Test-Path -LiteralPath $vcvars64) {
        Write-Step "Importing environment from vcvars64.bat"
        # Run the batch in a child cmd, then emit the resulting environment so
        # we can re-apply it to the current PowerShell process.
        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            cmd.exe /c "`"$vcvars64`" >nul 2>&1 && set > `"$tmp`""
            if ($LASTEXITCODE -ne 0) {
                throw "vcvars64.bat exited with code $LASTEXITCODE."
            }
            Get-Content -LiteralPath $tmp | ForEach-Object {
                if ($_ -match '^(?<k>[^=]+)=(?<v>.*)$') {
                    Set-Item -Path ("Env:" + $matches['k']) -Value $matches['v']
                }
            }
        } finally {
            Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
        }
        return
    }

    # Fallback: Enter-VsDevShell from Microsoft.VisualStudio.DevShell.dll.
    $devShellDll = Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
    if (Test-Path -LiteralPath $devShellDll) {
        Write-Step "Importing environment via Enter-VsDevShell"
        Import-Module $devShellDll
        $instanceId = & $vswhere -latest -prerelease -property instanceId
        Enter-VsDevShell -VsInstanceId $instanceId.Trim() `
            -SkipAutomaticLocation `
            -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
        return
    }

    throw "Neither vcvars64.bat nor Microsoft.VisualStudio.DevShell.dll was found under '$vsPath'. Reinstall the C++ build tools."
}

if (Test-X64ToolchainActive) {
    Write-Step "x64 MSVC toolchain already active (VSCMD_ARG_TGT_ARCH=$($env:VSCMD_ARG_TGT_ARCH)); reusing it"
} else {
    Import-VcVars64Environment
}

# Hard verification: nmake present and cl targets x64.
$nmake = Get-Command nmake.exe -ErrorAction SilentlyContinue
if (-not $nmake) { throw "nmake.exe is still not on PATH after environment setup." }
if ($env:VSCMD_ARG_TGT_ARCH -and $env:VSCMD_ARG_TGT_ARCH -ne 'x64') {
    throw "MSVC target arch is '$($env:VSCMD_ARG_TGT_ARCH)', expected 'x64'. (x86 builds trigger pgvector error C2196.)"
}
Write-Step "nmake: $($nmake.Source)"

# ---------------------------------------------------------------------------
# 3. Fetch pgvector source at the pinned tag
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $WorkDir) {
    Write-Step "Cleaning existing work dir $WorkDir"
    Remove-Item -LiteralPath $WorkDir -Recurse -Force
}
New-Item -ItemType Directory -Path $WorkDir | Out-Null

Write-Step "Cloning pgvector@$PgvectorRef"
git clone --depth 1 --branch $PgvectorRef https://github.com/pgvector/pgvector.git $WorkDir
if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)." }

Push-Location $WorkDir
try {
    # -----------------------------------------------------------------------
    # 4. Build + install via Makefile.win
    # -----------------------------------------------------------------------
    # Clean first so a stale x86 object cache can't poison an x64 rebuild.
    Write-Step 'nmake /F Makefile.win clean'
    & $nmake.Source /F Makefile.win clean
    # `clean` may be a no-op on a fresh tree; don't treat that as fatal.

    Write-Step 'nmake /F Makefile.win'
    & $nmake.Source /F Makefile.win
    if ($LASTEXITCODE -ne 0) { throw "build (nmake /F Makefile.win) failed (exit $LASTEXITCODE)." }

    Write-Step 'nmake /F Makefile.win install'
    & $nmake.Source /F Makefile.win install
    if ($LASTEXITCODE -ne 0) { throw "install (nmake /F Makefile.win install) failed (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 5. Verify the staged artifacts under PGROOT
# ---------------------------------------------------------------------------
$expected = @(
    (Join-Path $PgRoot 'lib\vector.dll'),
    (Join-Path $PgRoot 'share\extension\vector.control')
)
foreach ($f in $expected) {
    if (-not (Test-Path -LiteralPath $f)) {
        throw "Expected artifact not found after install: $f"
    }
    Write-Host "    OK  $f" -ForegroundColor Green
}
$sql = Get-ChildItem -LiteralPath (Join-Path $PgRoot 'share\extension') -Filter 'vector--*.sql' -ErrorAction SilentlyContinue
if (-not $sql) { throw "No vector--*.sql files in $PgRoot\share\extension." }
Write-Host "    OK  $($sql.Count) vector--*.sql file(s) in share\extension" -ForegroundColor Green

Write-Step "pgvector $PgvectorRef built and installed into $PgRoot"
