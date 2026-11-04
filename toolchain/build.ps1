param(
    [string]$ProjectPath = (Join-Path $PSScriptRoot '..\android'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\dist\NotaFlow.apk'),
    [string]$JavaHome = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}

$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$sdk = Join-Path $PSScriptRoot 'sdk'
$androidJar = Get-ChildItem -LiteralPath (Join-Path $sdk 'platform') -Recurse -Filter android.jar | Select-Object -First 1 -ExpandProperty FullName
$aapt2 = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Recurse -Filter aapt2.exe | Select-Object -First 1 -ExpandProperty FullName
if (-not $androidJar -or -not $aapt2) { throw 'Android SDK platform 35 and build tools must be extracted under toolchain/sdk.' }
$buildTools = Split-Path -Parent $aapt2
$env:JAVA_HOME = $JavaHome
$javaBin = Join-Path $JavaHome 'bin'
$env:PATH = "$javaBin;$env:PATH"
$build = Join-Path $ProjectPath 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$classes = Join-Path $build 'classes'
$generated = Join-Path $build 'generated'
$dex = Join-Path $build 'dex'
foreach ($dir in @($classes,$generated,$dex)) {
    if (Test-Path -LiteralPath $dir) {
        $full = [IO.Path]::GetFullPath($dir)
        if (-not $full.StartsWith($ProjectPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build directory.' }
        Remove-Item -LiteralPath $full -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
$compiledResources = Join-Path $build 'resources.zip'
$unsigned = Join-Path $build 'unsigned.apk'
$aligned = Join-Path $build 'aligned.apk'
foreach ($file in @($compiledResources,$unsigned,$aligned)) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }

Invoke-Checked $aapt2 @('compile','--dir',(Join-Path $ProjectPath 'res'),'-o',$compiledResources)
Invoke-Checked $aapt2 @('link','-o',$unsigned,'-I',$androidJar,'--manifest',(Join-Path $ProjectPath 'AndroidManifest.xml'),'--java',$generated,'-A',(Join-Path $ProjectPath 'assets'),'--min-sdk-version','26','--target-sdk-version','35',$compiledResources)
$javaSources = @(Get-ChildItem -LiteralPath (Join-Path $ProjectPath 'src'),$generated -Recurse -Filter '*.java' | Select-Object -ExpandProperty FullName)
Invoke-Checked (Join-Path $javaBin 'javac.exe') (@('--release','8','-encoding','UTF-8','-classpath',$androidJar,'-d',$classes) + $javaSources)
$classJar = Join-Path $build 'classes.jar'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $classJar) { Remove-Item -LiteralPath $classJar -Force }
[IO.Compression.ZipFile]::CreateFromDirectory($classes,$classJar,[IO.Compression.CompressionLevel]::Optimal,$false)
Invoke-Checked (Join-Path $buildTools 'd8.bat') @('--release','--min-api','26','--lib',$androidJar,'--output',$dex,$classJar)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($unsigned,[IO.Compression.ZipArchiveMode]::Update)
try {
    foreach ($dexFile in (Get-ChildItem -LiteralPath $dex -Filter '*.dex')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$dexFile.FullName,$dexFile.Name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $zip.Dispose() }
Invoke-Checked (Join-Path $buildTools 'zipalign.exe') @('-f','-p','4',$unsigned,$aligned)

$signing = Join-Path $PSScriptRoot 'signing'
New-Item -ItemType Directory -Force -Path $signing | Out-Null
$keyStore = Join-Path $signing 'notaflow-release.jks'
$passFile = Join-Path $signing 'signing-password.txt'
if (-not (Test-Path -LiteralPath $keyStore)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($bytes)
    [IO.File]::WriteAllText($passFile,$password,[Text.UTF8Encoding]::new($false))
    $env:NOTAFLOW_SIGNING_PASSWORD = $password
    Invoke-Checked (Join-Path $javaBin 'keytool.exe') @('-genkeypair','-keystore',$keyStore,'-storetype','JKS','-alias','notaflow','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=NotaFlow, OU=Aplicativo, O=NotaFlow, L=Salvador, ST=BA, C=BR','-storepass:env','NOTAFLOW_SIGNING_PASSWORD','-keypass:env','NOTAFLOW_SIGNING_PASSWORD','-noprompt')
} else {
    if (-not (Test-Path -LiteralPath $passFile)) { throw 'Signing password file is missing; preserve the release key for updates.' }
    $env:NOTAFLOW_SIGNING_PASSWORD = [IO.File]::ReadAllText($passFile).Trim()
}
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    Invoke-Checked (Join-Path $buildTools 'apksigner.bat') @('sign','--ks',$keyStore,'--ks-key-alias','notaflow','--ks-pass','env:NOTAFLOW_SIGNING_PASSWORD','--key-pass','env:NOTAFLOW_SIGNING_PASSWORD','--out',$OutputPath,$aligned)
    Invoke-Checked (Join-Path $buildTools 'apksigner.bat') @('verify','--verbose','--print-certs',$OutputPath)
    Invoke-Checked (Join-Path $buildTools 'zipalign.exe') @('-c','-p','4',$OutputPath)
} finally { Remove-Item Env:\NOTAFLOW_SIGNING_PASSWORD -ErrorAction SilentlyContinue }
Write-Output "APK: $OutputPath"
Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath | Format-List
