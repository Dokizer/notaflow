param(
    [string]$GitHubConfigDirectory
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedOrigin = 'https://github.com/rodrigosantossilv/notaflow.git'
$environmentNames = @(
    'GH_CONFIG_DIR', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_TERMINAL_PROMPT',
    'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_TRACE_PACKET',
    'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_TRACE_REDACT'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$locationChanged = $false
$tokenLines = $null
$token = $null
$credentialBytes = $null
$authorizationHeader = $null

try {
    if ($PSBoundParameters.ContainsKey('GitHubConfigDirectory')) {
        if ([string]::IsNullOrWhiteSpace($GitHubConfigDirectory) -or
            -not (Test-Path -LiteralPath $GitHubConfigDirectory -PathType Container)) {
            throw 'A pasta de configuracao do GitHub CLI nao existe.'
        }
        $env:GH_CONFIG_DIR = (Resolve-Path -LiteralPath $GitHubConfigDirectory).ProviderPath
    }

    $ghCommand = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ghCommand) {
        $ghExecutable = $ghCommand.Source
    } elseif (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe' -PathType Leaf) {
        $ghExecutable = 'C:\Program Files\GitHub CLI\gh.exe'
    } else {
        throw 'GitHub CLI nao encontrado. Instale o gh e autentique com gh auth login.'
    }
    $gitExecutable = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

    Push-Location -LiteralPath $repositoryRoot
    $locationChanged = $true

    $branch = & $gitExecutable branch --show-current
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw 'Sincronizacao interrompida: a branch atual precisa ser main.'
    }
    $origin = & $gitExecutable remote get-url origin
    if ($LASTEXITCODE -ne 0 -or $origin -cne $expectedOrigin) {
        throw 'Sincronizacao interrompida: origin difere do repositorio privado esperado.'
    }
    $workingTree = @(& $gitExecutable status --porcelain=v1)
    if ($LASTEXITCODE -ne 0 -or $workingTree.Count -ne 0) {
        throw 'Ha alteracoes sem commit. Revise e faca git add e git commit antes de sincronizar.'
    }
    $localHead = & $gitExecutable rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $localHead -notmatch '^[0-9a-f]{40}$') {
        throw 'Nao foi possivel identificar o commit local.'
    }

    # O token fica apenas na memoria e no ambiente temporario dos processos Git.
    $tokenLines = @(& $ghExecutable auth token --hostname github.com 2>$null)
    if ($LASTEXITCODE -ne 0 -or $tokenLines.Count -ne 1 -or
        [string]::IsNullOrWhiteSpace([string]$tokenLines[0])) {
        throw 'GitHub CLI sem autenticacao valida. Execute gh auth login antes de continuar.'
    }
    $token = ([string]$tokenLines[0]).Trim()
    $credentialBytes = [Text.Encoding]::UTF8.GetBytes('x-access-token:' + $token)
    $authorizationHeader = 'AUTHORIZATION: basic ' + [Convert]::ToBase64String($credentialBytes)
    foreach ($name in @('GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE',
        'GIT_TRACE_PACKET', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF')) {
        Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
    }
    $env:GIT_TRACE_REDACT = '1'
    $env:GIT_CONFIG_COUNT = '2'
    $env:GIT_CONFIG_KEY_0 = 'credential.helper'
    $env:GIT_CONFIG_VALUE_0 = ''
    $env:GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader'
    $env:GIT_CONFIG_VALUE_1 = $authorizationHeader
    $env:GIT_TERMINAL_PROMPT = '0'

    $remoteLines = @(& $gitExecutable ls-remote origin refs/heads/main)
    if ($LASTEXITCODE -ne 0) {
        throw 'Nao foi possivel consultar o GitHub. Nenhum push foi executado.'
    }
    if ($remoteLines.Count -gt 0) {
        if ($remoteLines.Count -ne 1 -or
            $remoteLines[0] -notmatch '^([0-9a-f]{40})\s+refs/heads/main$') {
            throw 'Resposta inesperada para main no GitHub. Operacao interrompida.'
        }
        $remoteHead = $Matches[1]
        & $gitExecutable cat-file -e ($remoteHead + '^{commit}') 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'O commit remoto nao esta disponivel localmente. Pare e revise o historico antes de enviar.'
        }
        & $gitExecutable merge-base --is-ancestor $remoteHead $localHead
        if ($LASTEXITCODE -ne 0) {
            throw 'O historico remoto divergiu do local. Pare e avise o usuario; nao force o envio.'
        }
    }

    Write-Output 'Enviando main para o repositorio privado NotaFlow...'
    & $gitExecutable push -u origin main
    if ($LASTEXITCODE -ne 0) {
        throw 'O push falhou. Operacao interrompida, sem nova tentativa e sem forcar o historico.'
    }

    $finalLocalHead = & $gitExecutable rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $finalLocalHead -ne $localHead) {
        throw 'O commit local mudou durante o envio. Revise o estado antes de continuar.'
    }
    $finalRemoteLines = @(& $gitExecutable ls-remote origin refs/heads/main)
    if ($LASTEXITCODE -ne 0 -or $finalRemoteLines.Count -ne 1 -or
        $finalRemoteLines[0] -notmatch '^([0-9a-f]{40})\s+refs/heads/main$') {
        throw 'O envio ocorreu, mas nao foi possivel confirmar o commit final do GitHub.'
    }
    if ($Matches[1] -ne $finalLocalHead) {
        throw 'Os commits local e remoto nao coincidem. Pare e avise o usuario.'
    }
    $finalWorkingTree = @(& $gitExecutable status --porcelain=v1)
    if ($LASTEXITCODE -ne 0 -or $finalWorkingTree.Count -ne 0) {
        throw 'Os commits coincidem, mas existem alteracoes locais sem commit. Revise o estado.'
    }
    Write-Output ('Sincronizacao confirmada. Commit local e GitHub: ' + $finalLocalHead)
} finally {
    if ($credentialBytes) {
        [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
    }
    $tokenLines = $null
    $token = $null
    $credentialBytes = $null
    $authorizationHeader = $null
    try {
        foreach ($name in $environmentNames) {
            if ($null -eq $previousEnvironment[$name]) {
                Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
            }
        }
    } finally {
        $previousEnvironment.Clear()
        if ($locationChanged) { Pop-Location }
    }
}
