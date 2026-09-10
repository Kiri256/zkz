#Requires -Version 5.1
<#
.SYNOPSIS
  Initialize current PowerShell console for UTF-8 (Chinese-safe).

.DESCRIPTION
  Used by:
  - Cursor/VS Code integrated terminal Profile (.vscode/settings.json)
  - Cursor Agent Shell (project hook preToolUse prepends this script)
  - zkz run_ps.ps1 (dot-sources this instead of duplicating)

  Sets chcp 65001, Console In/Out UTF-8, $OutputEncoding UTF-8, PYTHONIOENCODING/PYTHONUTF8.
#>
try { chcp 65001 | Out-Null } catch { }
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8 } catch { }
try { [Console]::InputEncoding = $utf8 } catch { }
$OutputEncoding = $utf8
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
# Keep session open when launched via: powershell -NoExit -File this.ps1
