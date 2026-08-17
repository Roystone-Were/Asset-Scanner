<#
.SYNOPSIS
  Backfill Purchase Date / Purchase Price (and optional Useful Life) for
  Xana Asset Inventory rows, batched from a CSV.

  CSV columns (header row required):
    AssetTag|Serial, PurchaseDate (yyyy-mm-dd), PurchasePrice (number),
    UsefulLife (optional years)

  Matching: tries Asset Tag first, then Serial Number. Blank price stays blank.

.EXAMPLE
  pwsh -NoProfile -File .\Backfill-PurchaseData.ps1 -Csv .\purchase-backfill.csv
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$Csv        = (Join-Path $PSScriptRoot "purchase-backfill.csv")
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively..." -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

if (-not (Test-Path $Csv)) { throw "CSV not found: $Csv" }
$rows = Import-Csv -Path $Csv
Write-Host "Rows to process: $($rows.Count)" -ForegroundColor Cyan

$items = Get-PnPListItem -List $ListTitle -PageSize 500
$byTag = @{}; $bySerial = @{}
foreach ($i in $items) {
  $tag = [string]$i.FieldValues['Title']; $ser = [string]$i.FieldValues['SerialNumber']
  if ($tag) { $byTag[$tag.Trim()] = $i }
  if ($ser) { $bySerial[$ser.Trim()] = $i }
}

$updated = 0; $matched = 0; $failed = @()
foreach ($r in $rows) {
  $item = $null
  if ($r.AssetTag) { $item = $byTag[[string]$r.AssetTag.Trim()] }
  if (-not $item -and $r.Serial) { $item = $bySerial[[string]$r.Serial.Trim()] }
  if (-not $item) { $failed += ($r.AssetTag + '/' + $r.Serial); continue }
  $matched++

  $values = @{}
  if ($r.PurchaseDate) { $values['PurchaseDate'] = [datetime]::ParseExact([string]$r.PurchaseDate, 'yyyy-MM-dd', $null) }
  if ($r.PurchasePrice -ne '' -and $null -ne $r.PurchasePrice) { $values['PurchasePrice'] = [string]$r.PurchasePrice }
  if ($r.UsefulLife) { $values['UsefulLife'] = [double]$r.UsefulLife }
  if ($values.Count -eq 0) { continue }

  Set-PnPListItem -List $ListTitle -Identity $item.Id -Values $values
  $updated++
  Write-Host "  updated Item $($item.Id) ($($item.FieldValues['Title'])): $($values.Keys -join ', ')" -ForegroundColor Green
}

Write-Host "" -ForegroundColor Cyan
Write-Host "Matched: $matched | Updated: $updated | Not found: $($failed.Count)" -ForegroundColor Cyan
if ($failed.Count) {
  Write-Host "Unmatched rows (check exact tag/serial):" -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host "  $_" }
}
Disconnect-PnPOnline