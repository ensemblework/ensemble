# Ensemble CLI installer for Windows PowerShell 5.1+.
#
# Installs to:
#   $env:ENSEMBLE_INSTALL_DIR\<version>\ensemble
# or:
#   $env:LOCALAPPDATA\Programs\Ensemble\<version>\ensemble
# and points a stable "current" junction/copy at that version.
#
# Set $env:ENSEMBLE_VERSION = "0.1.0" (or "cli-v0.1.0") to pin a version.
# Set $env:ENSEMBLE_DOWNLOAD_BASE to test against a directory containing the
# archive and SHA256SUMS.txt.
#
# Uninstall:
#   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Ensemble"
#   Remove the Ensemble current\bin entry from the user PATH.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "ensemblework/ensemble"
$ApiUrl = "https://api.github.com/repos/$Repo/releases?per_page=30"

function Fail($Message) {
  Write-Error "install.ps1: $Message"
  exit 1
}

function Normalize-Version($Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  if ($Value.StartsWith("cli-v")) {
    return @{ Version = $Value.Substring(5); Tag = $Value }
  }
  return @{ Version = $Value; Tag = "cli-v$Value" }
}

function Get-LatestCliVersion {
  $Releases = Invoke-RestMethod -UseBasicParsing -Uri $ApiUrl
  $Release = $Releases | Where-Object {
    -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^cli-v'
  } | Select-Object -First 1
  if (-not $Release) { Fail "could not find a non-draft cli-v* release" }
  return Normalize-Version $Release.tag_name
}

function Download-File($Uri, $OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
}

if (-not [Environment]::Is64BitOperatingSystem) {
  Fail "only 64-bit Windows is supported"
}

$Pinned = Normalize-Version $env:ENSEMBLE_VERSION
if ($Pinned) {
  $Selected = $Pinned
} elseif ($env:ENSEMBLE_DOWNLOAD_BASE) {
  Fail "ENSEMBLE_VERSION is required when ENSEMBLE_DOWNLOAD_BASE is set"
} else {
  $Selected = Get-LatestCliVersion
}

$Version = $Selected.Version
$Tag = $Selected.Tag
$ArchiveName = "ensemble-cli-$Version-windows-x64.zip"
$Base = $env:ENSEMBLE_DOWNLOAD_BASE
if ([string]::IsNullOrWhiteSpace($Base)) {
  $Base = "https://github.com/$Repo/releases/download/$Tag"
}
$Base = $Base.TrimEnd("/")
$ArchiveUrl = "$Base/$ArchiveName"
$SumsUrl = "$Base/SHA256SUMS.txt"

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("ensemble-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  Write-Host "Downloading Ensemble CLI $Version for windows-x64..."
  $ArchivePath = Join-Path $Temp $ArchiveName
  $SumsPath = Join-Path $Temp "SHA256SUMS.txt"
  Download-File $ArchiveUrl $ArchivePath
  Download-File $SumsUrl $SumsPath

  $EscapedName = [regex]::Escape($ArchiveName)
  $Line = Get-Content $SumsPath | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$EscapedName$" } | Select-Object -First 1
  if (-not $Line) { Fail "SHA256SUMS.txt does not contain $ArchiveName" }
  $Expected = ([regex]::Match($Line, "^([0-9a-fA-F]{64})")).Groups[1].Value.ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { Fail "sha256 mismatch for $ArchiveName" }

  $Root = $env:ENSEMBLE_INSTALL_DIR
  if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Join-Path $env:LOCALAPPDATA "Programs\Ensemble"
  }
  $VersionRoot = Join-Path $Root $Version
  $VersionEnsemble = Join-Path $VersionRoot "ensemble"
  $Payload = Join-Path $Temp "payload"
  New-Item -ItemType Directory -Force -Path $Payload | Out-Null
  Expand-Archive -Path $ArchivePath -DestinationPath $Payload -Force
  $Extracted = Join-Path $Payload "ensemble"
  $Exe = Join-Path $Extracted "bin\ensemble.exe"
  if (-not (Test-Path $Exe)) { Fail "archive did not contain ensemble\bin\ensemble.exe" }

  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  if (-not (Test-Path $VersionEnsemble)) {
    New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null
    Move-Item -Path $Extracted -Destination $VersionEnsemble
  }

  $Current = Join-Path $Root "current"
  $CurrentTmp = Join-Path $Root ("current.tmp." + $PID)
  # Windows PowerShell 5.1 follows junctions with Remove-Item -Recurse and
  # deletes the target's files. Remove a junction itself, never its contents.
  function Remove-CurrentLink([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      [IO.Directory]::Delete($Path)
    } else {
      Remove-Item -LiteralPath $Path -Recurse -Force
    }
  }
  Remove-CurrentLink $CurrentTmp
  $cmd = "mklink /J `"$CurrentTmp`" `"$VersionEnsemble`""
  cmd.exe /c $cmd | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Copy-Item -Recurse -Path $VersionEnsemble -Destination $CurrentTmp
  }
  Remove-CurrentLink $Current
  Move-Item -Path $CurrentTmp -Destination $Current

  $BinPath = Join-Path $Current "bin"
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Parts = @()
  if (-not [string]::IsNullOrWhiteSpace($UserPath)) {
    $Parts = $UserPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }
  $Contains = $false
  foreach ($Part in $Parts) {
    if ([string]::Equals($Part.TrimEnd([char]'\'), $BinPath.TrimEnd([char]'\'), [StringComparison]::OrdinalIgnoreCase)) {
      $Contains = $true
      break
    }
  }
  if (-not $Contains) {
    $NewPath = (@($Parts) + $BinPath) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    if ($env:Path -notlike "*$BinPath*") { $env:Path = "$env:Path;$BinPath" }
    Write-Host "Added $BinPath to the user PATH. Open a new terminal if needed."
  }

  Write-Host "Ensemble CLI $Version installed at $VersionEnsemble"
  Write-Host "Next step: ensemble login"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
