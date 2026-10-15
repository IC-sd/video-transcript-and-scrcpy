[CmdletBinding()]
param(
    [string]$LocalSource,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$lock = Get-Content -LiteralPath (Join-Path $projectRoot 'dependencies.lock.json') -Raw | ConvertFrom-Json
$pythonTarget = Join-Path $projectRoot 'runtime\python'
$engineTarget = Join-Path $projectRoot 'tools\scrcpy'

function Assert-ProjectPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Destination leaves project directory: $absolute"
    }
    return $absolute
}

function Test-Dependencies([string]$PythonDirectory, [string]$EngineDirectory) {
    foreach ($relative in @('python.exe', 'python313.dll', 'python313.zip', 'LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $PythonDirectory $relative) -PathType Leaf)) {
            throw "Incomplete Python runtime: $relative"
        }
    }
    foreach ($relative in @('scrcpy.exe', 'scrcpy-server', 'adb.exe', 'LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $EngineDirectory $relative) -PathType Leaf)) {
            throw "Incomplete scrcpy runtime: $relative"
        }
    }
    $pythonPath = Join-Path $PythonDirectory 'python.exe'
    & $pythonPath -X utf8 -B -c "import sys; sys.path.insert(0, sys.argv[1]); import mirror; print('Python', sys.version.split()[0], '- launcher imports OK')" (Join-Path $projectRoot 'app')
    if ($LASTEXITCODE -ne 0) { throw 'Python launcher import check failed.' }
}

if ($VerifyOnly) {
    Test-Dependencies $pythonTarget $engineTarget
    Write-Output 'Dependencies verified. No phone connection was started.'
    exit 0
}
if ((Test-Path -LiteralPath $pythonTarget) -or (Test-Path -LiteralPath $engineTarget)) {
    if ((Test-Path -LiteralPath $pythonTarget) -and (Test-Path -LiteralPath $engineTarget)) {
        Test-Dependencies $pythonTarget $engineTarget
        Write-Output 'Dependencies are already installed.'
        exit 0
    }
    throw 'A partial dependency directory exists. Move it aside before installing, or repair it manually.'
}
$staging = Assert-ProjectPath (Join-Path $projectRoot ('.setup-cache\' + [Guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
$stagedPython = Assert-ProjectPath (Join-Path $staging 'python')
$stagedEngine = Assert-ProjectPath (Join-Path $staging 'scrcpy')

function Get-VerifiedArchive($Dependency, [string]$FileName) {
    $uri = [Uri]$Dependency.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('www.python.org', 'github.com')) {
        throw 'Only the locked official HTTPS download hosts are supported.'
    }
    $archive = Assert-ProjectPath (Join-Path $staging $FileName)
    Write-Host "Downloading $($uri.AbsoluteUri)"
    Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $archive -UseBasicParsing
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $Dependency.sha256) { throw "SHA-256 mismatch for $FileName" }
    return $archive
}

if ($LocalSource) {
    $sourceRoot = (Resolve-Path -LiteralPath $LocalSource).Path
    foreach ($relative in @('runtime\python', 'tools\scrcpy')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relative) -PathType Container)) {
            throw "Missing dependency directory in local source: $relative"
        }
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'runtime\python') -Destination $stagedPython -Recurse
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'tools\scrcpy') -Destination $stagedEngine -Recurse
    $manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'docs\imported-dependencies.json') -Raw | ConvertFrom-Json
    foreach ($file in $manifest) {
        $relative = $file.path -replace '^runtime/python/', 'python/' -replace '^tools/scrcpy/', 'scrcpy/'
        $copied = Assert-ProjectPath (Join-Path $staging $relative)
        if ((Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Local dependency differs from the imported version: $($file.path)"
        }
    }
} else {
    $pythonArchive = Get-VerifiedArchive $lock.python 'python.zip'
    Expand-Archive -LiteralPath $pythonArchive -DestinationPath $stagedPython
    $engineArchive = Get-VerifiedArchive $lock.scrcpy 'scrcpy.zip'
    $engineExtract = Assert-ProjectPath (Join-Path $staging 'engine-extract')
    Expand-Archive -LiteralPath $engineArchive -DestinationPath $engineExtract
    $engineSource = Assert-ProjectPath (Join-Path $engineExtract ('scrcpy-win64-v' + $lock.scrcpy.version))
    if (-not (Test-Path -LiteralPath $engineSource -PathType Container)) { throw 'Unexpected scrcpy archive layout.' }
    Copy-Item -LiteralPath $engineSource -Destination $stagedEngine -Recurse
    @('.', 'python313.zip', 'DLLs', '../../app') | Set-Content -LiteralPath (Join-Path $stagedPython 'python313._pth') -Encoding ASCII
}
Test-Dependencies $stagedPython $stagedEngine
Assert-ProjectPath $pythonTarget | Out-Null
Assert-ProjectPath $engineTarget | Out-Null
Move-Item -LiteralPath $stagedPython -Destination $pythonTarget
Move-Item -LiteralPath $stagedEngine -Destination $engineTarget
Write-Output 'Setup complete. Run the launcher BAT file to start mirroring.'
