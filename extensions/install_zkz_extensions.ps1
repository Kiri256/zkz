$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$packages = @('zkz-sandbox', 'zkz-code', 'zkz-keil')
$sandboxFiles = @(
  'extension.js', 'sync.js', 'status_bar.js', 'host.js', 'optional.js',
  'pair.js', 'git_manage.js', 'toast.js', 'shared.js',
  'sync_gate.js', 'pair_diff.js', 'pair_diff_batch.js', 'dashboard.js',
  'sync_hint.js', 'session_edits.js', 'encoding.js', 'w1_fs.js',
  'blame.js', 'git.js', 'time_fmt.js', 'branch_cache.js', 'git_ops.js', 'scm.js',
  'tree.js', 'tree_nodes.js', 'tree_changes.js', 'tree_branches.js', 'tree_w1.js',
  'w1_files.js', 'commands.js', 'commit_ui.js', 'history_diff.js', 'branch_ops.js', 'w1_ops.js',
  'lists.js', 'sync_engine.js', 'compile_commands.js', 'workspace_lists.json'
)
$codeFiles = @(
  'extension.js', 'status.js', 'util.js',
  'macros.js', 'macro_impact.js', 'ifdef_fold.js', 'encoding.js',
  'pair.js', 'fffd.js', 'lists.js', 'toast.js',
  'compile_commands.js', 'workspace_lists.json'
)
$keilFiles = @(
  'extension.js', 'keil.js', 'keil_flash.js', 'keil_tasks.js',
  'keil_layout.js', 'git_sync.js', 'pair.js'
)
$only = @()
if ($env:ZKZ_EXTENSIONS) { $only = $env:ZKZ_EXTENSIONS.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
if ($only.Count) { $packages = $packages | Where-Object { $only -contains $_ } }
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-Version([string]$pkg) {
  $obj = Get-Content (Join-Path $root "$pkg\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$obj.version
}

function New-Vsix([string]$pkg) {
  $src = Join-Path $root $pkg
  $ver = Get-Version $pkg
  $out = Join-Path $root "$pkg-$ver.vsix"
  $stage = Join-Path $env:TEMP ("zkz-$pkg-" + [guid]::NewGuid().ToString('N'))
  $ext = Join-Path $stage 'extension'
  New-Item -ItemType Directory -Path $ext -Force | Out-Null
  Copy-Item (Join-Path $src 'package.json') $ext
  Copy-Item (Join-Path $src 'README.md') $ext -ErrorAction SilentlyContinue
  $sourceFiles = $null
  if ($pkg -eq 'zkz-sandbox') { $sourceFiles = $sandboxFiles }
  elseif ($pkg -eq 'zkz-code') { $sourceFiles = $codeFiles }
  elseif ($pkg -eq 'zkz-keil') { $sourceFiles = $keilFiles }
  if ($sourceFiles) {
    $srcDest = Join-Path $ext 'src'
    New-Item -ItemType Directory -Path $srcDest -Force | Out-Null
    foreach ($file in $sourceFiles) {
      $sourceFile = Join-Path $src "src\$file"
      if (-not (Test-Path $sourceFile)) { throw "Missing package source file: $sourceFile" }
      Copy-Item $sourceFile $srcDest
    }
  } else {
    Copy-Item (Join-Path $src 'src') (Join-Path $ext 'src') -Recurse
  }
  Copy-Item (Join-Path $src 'node_modules') (Join-Path $ext 'node_modules') -Recurse -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $src 'media') (Join-Path $ext 'media') -Recurse -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $ext 'src') -Filter '*.js' -File -Recurse | ForEach-Object {
    & node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "node --check failed: $($_.FullName)" }
  }
  $ct = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
'@
  [IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), $ct, $utf8)
  $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id="$pkg" Version="$ver" Publisher="zkz" /><DisplayName>$pkg</DisplayName><Description>zkz independent extension</Description><Categories>Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" /></Properties></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"@
  [IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), $manifest, $utf8)
  if (Test-Path $out) { Remove-Item $out -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $out)
  Remove-Item $stage -Recurse -Force
  Write-Host "Built $out"
  return @{ Package = $pkg; Version = $ver; Vsix = $out }
}

$built = @($packages | ForEach-Object { New-Vsix $_ })

function Resolve-EditorCli([string]$name, [string[]]$paths) {
  foreach ($p in $paths) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $src = [string]$cmd.Source
  # Cursor 也可能在 PATH 里提供 code.cmd，不能当成 VS Code
  if ($name -eq 'code' -and $src -match '[\\/]cursor[\\/]') { return $null }
  return $src
}

function Install-ZkzToEditor([string]$label, [string]$cli) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $cli --uninstall-extension zkz.zkz-git 2>$null | Out-Null
  & $cli --uninstall-extension zkz.zkz-w1-git 2>$null | Out-Null
  & $cli --uninstall-extension zkz.zkz-sync 2>$null | Out-Null
  & $cli --uninstall-extension zkz.zkz-git-core 2>$null | Out-Null
  $ErrorActionPreference = $oldPreference
  foreach ($item in $built) {
    & $cli --install-extension $item.Vsix --force
    if ($LASTEXITCODE -ne 0) { throw "$label install failed: $($item.Package)" }
  }
  Write-Host "Installed selected zkz extensions into $label. Reload $label."
}

# 默认同时装 Cursor 和 VS Code；ZKZ_INSTALL=0 才只打 vsix
if ($env:ZKZ_INSTALL -ne '0') {
  $cursor = Resolve-EditorCli 'cursor' @(
    $env:ZKZ_CURSOR,
    'D:\ruanjian\cursor\resources\app\bin\cursor.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.cmd')
  )
  $code = Resolve-EditorCli 'code' @(
    $env:ZKZ_VSCODE,
    'D:\ruanjian\Microsoft VS Code\bin\code.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path ${env:ProgramFiles} 'Microsoft VS Code\bin\code.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd')
  )
  if (-not $cursor) { throw 'Cursor CLI not found. Set ZKZ_CURSOR or install Cursor.' }
  if (-not $code) { throw 'VS Code CLI not found. Set ZKZ_VSCODE or install VS Code.' }
  Install-ZkzToEditor 'Cursor' $cursor
  Install-ZkzToEditor 'VS Code' $code
}
