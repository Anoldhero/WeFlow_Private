param(
    [ValidateSet('linux/amd64', 'linux/arm64')]
    [string]$Platform = 'linux/amd64',
    [string]$Image = 'zhiliao-cloud:0.3.1',
    [string]$BaseImage = 'registry-1.docker.io/library/node:24-bookworm-slim',
    [string]$Context = 'desktop-linux',
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if ([string]::IsNullOrWhiteSpace($Image) -or $Image.StartsWith('-') -or
    [string]::IsNullOrWhiteSpace($BaseImage) -or $BaseImage.StartsWith('-') -or
    [string]::IsNullOrWhiteSpace($Context) -or $Context.StartsWith('-')) {
    throw 'Image, BaseImage and Context must be non-empty values, not command options.'
}

$buildArguments = @(
    '--context', $Context,
    'buildx', 'build',
    '--platform', $Platform,
    '--load',
    '--progress=plain',
    '--build-arg', "NODE_BASE_IMAGE=$BaseImage",
    '--tag', $Image,
    '--file', (Join-Path $projectDirectory 'Dockerfile'),
    $projectDirectory
)

if ($Plan) {
    [ordered]@{
        image = $Image
        platform = $Platform
        baseImage = $BaseImage
        context = $Context
        arguments = $buildArguments
    } | ConvertTo-Json -Depth 3
    exit 0
}

Get-Command docker -ErrorAction Stop | Out-Null
$engineType = & docker --context $Context info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) {
    throw "Cannot access Docker context '$Context'. Start Docker Desktop and check access permissions."
}
if ($engineType.Trim() -ne 'linux') {
    throw 'This image requires a Linux container engine.'
}

& docker @buildArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Image build failed. No startup verification was performed.'
}

$expectedArchitecture = $Platform.Split('/')[1]
$actualArchitecture = & docker --context $Context image inspect $Image --format '{{.Architecture}}'
if ($LASTEXITCODE -ne 0 -or $actualArchitecture.Trim() -ne $expectedArchitecture) {
    throw "The loaded image does not match $Platform."
}

# Verifies Node and SQLite without starting a service or supplying model credentials.
& docker --context $Context run --rm --network none --platform $Platform --entrypoint node $Image `
    -e "if(process.versions.node.split('.')[0]!=='24')throw Error('Node 24 required'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE check_runtime(value INTEGER)'); db.close(); console.log('Node '+process.version+' / SQLite ready')"
if ($LASTEXITCODE -ne 0) {
    throw 'The image was built, but its Node/SQLite runtime verification failed.'
}

& docker --context $Context run --rm --network none --platform $Platform `
    --env NODE_ENV=development --env AI_PROVIDER=demo --env DATABASE_PATH=/tmp/image-check.sqlite `
    --entrypoint node $Image --input-type=module `
    -e "setTimeout(()=>process.exit(1),30000).unref(); await import('./dist-server/index.mjs'); const r=await fetch('http://127.0.0.1:4310/readyz',{signal:AbortSignal.timeout(5000)}); const h=await r.json(); if(!r.ok||h.status!=='ok'||h.mode!=='demo')throw Error('API readiness check failed'); console.log('API ready / version '+h.version); process.kill(process.pid,'SIGTERM')"
if ($LASTEXITCODE -ne 0) {
    throw 'The image was built, but its isolated API startup verification failed.'
}

Write-Output "Built and verified: $Image ($Platform)"
