$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path (Split-Path -Parent $projectRoot) "yourssu_peer_review_html_pdf_generator_portable_latest.zip"
$prefix = "yourssu_peer_review_html_pdf_generator"

function Get-PortableRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = [System.Uri]::new($baseFull)
    $targetUri = [System.Uri]::new($targetFull)
    return [System.Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($targetUri).ToString()
    ).Replace('/', '\')
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
}

$includedRoots = @(
    "app",
    "runtime",
    "tests",
    "README.txt",
    "sample-mixed-member.json",
    "start.cmd",
    "start.ps1",
    "stop.cmd",
    "stop.ps1",
    "package-portable.ps1"
)

$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
$archive = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
)

try {
    foreach ($relativeRoot in $includedRoots) {
        $fullRoot = Join-Path $projectRoot $relativeRoot
        if (-not (Test-Path -LiteralPath $fullRoot)) {
            continue
        }

        $item = Get-Item -LiteralPath $fullRoot
        $files = if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $fullRoot -File -Recurse
        } else {
            @($item)
        }

        foreach ($file in $files) {
            $relative = Get-PortableRelativePath -BasePath $projectRoot -TargetPath $file.FullName
            $entryName = ($prefix + "/" + $relative.Replace("\", "/"))
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $file.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
}
finally {
    $archive.Dispose()
    $stream.Dispose()
}

$zip = Get-Item -LiteralPath $target
Write-Host ("Portable package: {0} ({1:N1} MB)" -f $zip.FullName, ($zip.Length / 1MB))
