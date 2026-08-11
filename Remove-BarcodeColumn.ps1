<#
.SYNOPSIS
  Remove the temporary "Barcode" column used while proving the scan -> lookup
  flow, so the list stays clean. The scanner app now matches on the "Asset
  Tag" / "Asset" / "Serial Number" columns instead.

.EXAMPLE
  pwsh -NoProfile -File .\Remove-BarcodeColumn.ps1
#>
param(
  [string]$SiteUrl       = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle     = "Xana Asset Inventory",
  [string]$ClientId      = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant        = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint    = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$BarcodeColumn = "Barcode"
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively to: $SiteUrl" -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

$field = Get-PnPField -List $ListTitle -Identity $BarcodeColumn -ErrorAction SilentlyContinue
if ($field) {
  Remove-PnPField -List $ListTitle -Identity $BarcodeColumn -Force
  Write-Host "Removed column '$BarcodeColumn'." -ForegroundColor Green
} else {
  Write-Host "Column '$BarcodeColumn' not found - nothing to remove." -ForegroundColor Yellow
}

Write-Host "DONE. The Barcode column is gone. The app will match on 'Asset Tag' / 'Asset' / 'Serial Number'." -ForegroundColor Green
Disconnect-PnPOnline
