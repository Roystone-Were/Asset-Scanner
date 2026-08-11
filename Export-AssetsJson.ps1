<#
.SYNOPSIS
  Export the Xana Asset Inventory list to a normalized JSON snapshot used by
  the golden test suite (scanner-app/test/fixtures/assets.json). The tests
  pin real-world facts about this data (which asset MICL0045 resolves to, no
  false "Laptop" matches, duplicate serials are caught). Re-run this script
  after bulk changes to the list and commit the new snapshot.

.EXAMPLE
  pwsh -NoProfile -File .\Export-AssetsJson.ps1
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$OutJson    = (Join-Path $PSScriptRoot "scanner-app/test/fixtures/assets.json")
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively to: $SiteUrl" -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected. Reading list items..." -ForegroundColor Green

function Get-FieldV([object]$fields, [string]$name) {
  $n = ($name -replace '_x[0-9a-fA-F]{4}_', ' ' -replace '[^a-zA-Z0-9]', '')
  foreach ($k in $fields.Keys) {
    $norm = ($k -replace '_x[0-9a-fA-F]{4}_', ' ' -replace '[^a-zA-Z0-9]', '')
    if ($norm -ieq $n) { return $fields[$k] }
  }
  return $null
}

$items = Get-PnPListItem -List $ListTitle -PageSize 500
$rows = foreach ($i in $items) {
  $f = $i.FieldValues
  $tag = Get-FieldV $f 'Asset Tag'
  if (-not $tag) { $tag = $f['Title'] }
  $assetType = Get-FieldV $f 'Asset Type'
  if (-not $assetType) { $assetType = Get-FieldV $f 'Asset' }
  $lv = Get-FieldV $f 'Last Verified'
  if ($lv) { $lv = $lv.ToString('o') }
  [pscustomobject]@{
    id           = [int]$i.Id
    tag          = [string]$tag
    assetType    = [string]$assetType
    model        = [string](Get-FieldV $f 'Model')
    serial       = [string](Get-FieldV $f 'Serial Number')
    employee     = [string](Get-FieldV $f 'Employee Name')
    status       = [string](Get-FieldV $f 'Status')
    location     = [string](Get-FieldV $f 'Location')
    region       = [string](Get-FieldV $f 'Region')
    condition    = [string](Get-FieldV $f 'Condition')
    lastVerified = $lv
    url          = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData/Lists/Xana%20Asset%20Inventory/DispForm.aspx?ID=$($i.Id)"
  }
}
$rows = $rows | Sort-Object id

$dir = Split-Path -Parent $OutJson
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$rows | ConvertTo-Json -Depth 3 | Out-File $OutJson -Encoding UTF8
Write-Host "Exported $($rows.Count) assets -> $OutJson" -ForegroundColor Green
Write-Host "Commit the updated fixture so the golden tests pin the real data." -ForegroundColor Yellow

Disconnect-PnPOnline
