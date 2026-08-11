<#
.SYNOPSIS
  Add a "Barcode" column to the Xana Asset Inventory list (scan key) and set
  a test value on the Xana001 row so we can prove scanning -> metadata works.
#>
param(
  [string]$SiteUrl       = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle     = "Xana Asset Inventory",
  [string]$ClientId      = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant        = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint    = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$BarcodeColumn = "Barcode",
  [string]$TestBarcode   = "MICL0045",
  [int]$TestItemId       = 1
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

$item = Get-PnPListItem -List $ListTitle -Id $TestItemId
if ($item) {
  Set-PnPListItem -List $ListTitle -Identity $TestItemId -Values @{ "Barcode" = $TestBarcode }
  Write-Host "Set Barcode = '$TestBarcode' on item Id $TestItemId ($($item.FieldValues['Title']))." -ForegroundColor Green
} else {
  Write-Host "Item Id $TestItemId not found." -ForegroundColor Yellow
}

Write-Host "DONE. Scanning '$TestBarcode' will now match that asset." -ForegroundColor Green
Disconnect-PnPOnline
