# Run in your normal terminal after gh auth login.
[CmdletBinding()]
param([string]$RepositoryName = 'bookmark-sync')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($RepositoryName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid repository name.' }
$githubCli = Get-Command gh -ErrorAction SilentlyContinue
if (-not $githubCli) {
    $candidate = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Install GitHub CLI and run gh auth login first.' }
    $githubCli = $candidate
} else { $githubCli = $githubCli.Source }
$login = & $githubCli api user --jq '.login'
if ($LASTEXITCODE -ne 0 -or -not $login) { throw 'GitHub authentication failed. Run gh auth login in this terminal.' }
$login = $login.Trim()
$repository = "$login/$RepositoryName"

# Trust this requested workspace only, for these child processes. Leave global Git config unchanged.
$oldCount = [Environment]::GetEnvironmentVariable('GIT_CONFIG_COUNT', 'Process')
$slot = 0
if ($oldCount) { $slot = [int]$oldCount }
$keyName = "GIT_CONFIG_KEY_$slot"
$valueName = "GIT_CONFIG_VALUE_$slot"
$oldKey = [Environment]::GetEnvironmentVariable($keyName, 'Process')
$oldValue = [Environment]::GetEnvironmentVariable($valueName, 'Process')
$previousLocation = Get-Location
try {
    [Environment]::SetEnvironmentVariable($keyName, 'safe.directory', 'Process')
    [Environment]::SetEnvironmentVariable($valueName, $projectRoot, 'Process')
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT', [string]($slot + 1), 'Process')
    Set-Location -LiteralPath $projectRoot
    & git rev-parse --git-dir *> $null
    if ($LASTEXITCODE -ne 0) {
        & git init -b main
        if ($LASTEXITCODE -ne 0) { throw 'Git initialization failed.' }
    }
    $remotes = @(& git remote)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Git remotes.' }
    if ($remotes -contains 'origin') {
        $origin = & git remote get-url origin
        throw "Origin is already configured as $origin. Review it before publishing again."
    }
    & git add --all
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stage project files.' }
    & git diff --cached --quiet
    $diffExit = $LASTEXITCODE
    if ($diffExit -gt 1) { throw 'Unable to inspect staged changes.' }
    if ($diffExit -eq 1) {
        & git -c "user.name=$login" -c "user.email=$login@users.noreply.github.com" commit -m 'Build self-hosted bookmark sync extension and server'
        if ($LASTEXITCODE -ne 0) { throw 'Unable to commit project files.' }
    }
    & $githubCli repo create $repository --private --description 'Self-hosted bookmark sync for Chrome, Edge, and Firefox' --source $projectRoot --remote origin --push
    if ($LASTEXITCODE -ne 0) { throw 'GitHub publishing failed. Review the output above before retrying.' }
    Write-Host "Created and pushed: https://github.com/$repository"
} finally {
    Set-Location -LiteralPath $previousLocation.Path
    [Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT', $oldCount, 'Process')
    [Environment]::SetEnvironmentVariable($keyName, $oldKey, 'Process')
    [Environment]::SetEnvironmentVariable($valueName, $oldValue, 'Process')
}
