<#
.SYNOPSIS
  Unified PowerShell entry: force UTF-8 console, then run a zkz script.

.DESCRIPTION
  Use this instead of calling toolkit scripts directly when you care about Chinese
  in the console / captured stdout (Cursor Agent terminal, etc.).

  Named args (-SourceRoot, -Force, ...) are converted to a hashtable splat.
  Do NOT use `& $Script @stringArray` — that binds positionally and sets
  $SourceRoot = "-SourceRoot".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File run_ps.ps1 publish_sandbox_config.ps1
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [Alias('FilePath')]
    [string]$Script,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ErrorActionPreference = 'Stop'

# UTF-8 console / $OutputEncoding: shared init (also used by Cursor terminal Profile)
. (Join-Path $PSScriptRoot 'init_terminal_utf8.ps1')

# Strip shell-leftover quotes from path-like values (cmd/PS task quoting)
function Normalize-CliToken([string]$v) {
    if ($null -eq $v) { return $v }
    $t = $v.Trim()
    if (($t.Length -ge 2) -and (
        (($t.StartsWith("'") -and $t.EndsWith("'")) -or ($t.StartsWith('"') -and $t.EndsWith('"')))
    )) {
        $t = $t.Substring(1, $t.Length - 2)
    }
    return $t
}

$Script = Normalize-CliToken $Script
if (-not [System.IO.Path]::IsPathRooted($Script)) {
    $Script = Join-Path $PSScriptRoot $Script
}
$Script = [System.IO.Path]::GetFullPath($Script)
if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) {
    $leaf = Split-Path -Leaf $Script
    $hint = $null
    foreach ($c in @(
            (Join-Path $PSScriptRoot ("archive\" + $leaf)),
            (Join-Path $PSScriptRoot ("archive\keil\" + $leaf)),
            (Join-Path $PSScriptRoot ("archive\rare\" + $leaf))
        )) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { $hint = $c; break }
    }
    Write-Host ("ERROR: Script not found: {0}" -f $Script) -ForegroundColor Red
    if ($hint) {
        Write-Host "This CLI was archived. Use zkz-sandbox / zkz-code / zkz-keil. See scripts/archive/README.md" -ForegroundColor Yellow
    }
    exit 1
}

Write-Host ("run_ps -> {0}" -f (Split-Path -Leaf $Script)) -ForegroundColor DarkCyan

# Convert remaining CLI tokens into a named-parameter splat
$splat = @{}
$i = 0
$argsArr = @()
if ($null -ne $ScriptArgs) { $argsArr = @($ScriptArgs) }
while ($i -lt $argsArr.Count) {
    $tok = [string]$argsArr[$i]
    if ($tok -match '^-(.+)$') {
        $name = $Matches[1]
        $hasVal = ($i + 1) -lt $argsArr.Count -and -not ([string]$argsArr[$i + 1]).StartsWith('-')
        if ($hasVal) {
            $splat[$name] = (Normalize-CliToken ([string]$argsArr[$i + 1]))
            $i += 2
        }
        else {
            # switch (e.g. -Force / -DryRun)
            $splat[$name] = $true
            $i += 1
        }
    }
    else {
        Write-Warning ("Ignoring unexpected positional arg: {0}" -f $tok)
        $i += 1
    }
}

$global:LASTEXITCODE = 0
try {
    & $Script @splat
    if (-not $?) {
        Write-Host "ERROR: script reported failure." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed }
    exit 1
}
exit 0