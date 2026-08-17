<#
.SYNOPSIS
  Export every asset that is missing Purchase Date or Purchase Price into a CSV
  for a data-entry backfill pass (fill the blank columns, then run the importer).
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$OutCsv     = (Join-Path $PSScriptRoot "purchase-backfill.csv")
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively..." -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

function Get-V([hashtable]$f, [string]$name) {
  $n = ($name -replace '[^A-Za-z0-9]', '')
  foreach ($k in $f.Keys) { if (($k -replace '[^A-Za-z0-9]', '') -ieq $n) { return $f[$k] } }
  return $null
}

$items = Get-PnPListItem -List $ListTitle -PageSize 500
$rows = foreach ($i in $items) {
  $f = $i.FieldValues
  $price = [string](Get-V $f 'Purchase Price')
  $date  = [string](Get-V $f 'Purchase Date')
  $needPrice = [string]::IsNullOrWhiteSpace($price)
  $needDate  = [string]::IsNullOrWhiteSpace($date)
  if (-not $needPrice -and -not $needDate) { continue }
  [pscustomobject]@{
    AssetTag      = [string]$f['Title']
    Serial        = [string](Get-V $f 'Serial Number')
    Model         = [string](Get-V $f 'Model')
    AssetType     = [string](Get-V $f 'Asset Type')
    Missing       = 'yes'
    PurchaseDate  = ''
    PurchasePrice = ''
  }
}
$rows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8
Write-Host "Exported $($rows.Count) assets missing purchase data -> $OutCsv" -ForegroundColor Green
Disconnect-PnPOnline