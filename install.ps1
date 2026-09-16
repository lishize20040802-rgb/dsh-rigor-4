#Requires -Version 5
# Thin compatibility entry point. The Node installer defaults to a read-only preview.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'scripts\install.mjs'
& node $installer @args
exit $LASTEXITCODE
