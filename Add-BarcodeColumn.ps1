<#
.SYNOPSIS
  Add a "Barcode" column to the Xana Asset Inventory list. This is the
  register-on-scan target: when the app finds no match for a scanned vendor
  barcode, staff tap "Register this barcode", pick the device, and the app
  writes the barcode into this column. The next scan then matches it.

  (The earlier version of this script also planted a test barcode on item 1;
  the app now writes barcodes itself, so this only creates the column.)

.EXAMPLE
  pwsh -NoProfile -File .\Add-BarcodeColumn.ps1
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
if (-not $field) {
  Add-PnPField -List $ListTitle -DisplayName $BarcodeColumn -InternalName "Barcode" -Type Text -AddToDefaultView
  Write-Host "Added column '$BarcodeColumn'." -ForegroundColor Green
} else {
  Write-Host "Column '$BarcodeColumn' already exists." -ForegroundColor Yellow
}

Disconnect-PnPOnline
Write-Host "DONE. The app's register-on-scan flow will write barcodes into '$BarcodeColumn'." -ForegroundColor Green
