<#
.SYNOPSIS
  Add a "Last Verified By" text column to the Xana Asset Inventory list. The
  scanner app writes the signed-in user's name here on every scan, so the list
  shows WHO verified each device - not just when. Used by the app's history
  view and the monthly health report.

.EXAMPLE
  pwsh -NoProfile -File .\Add-LastVerifiedByColumn.ps1
#>
param(
  [string]$SiteUrl       = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle     = "Xana Asset Inventory",
  [string]$ClientId      = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant        = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint    = "B4437765C89E84AE84B813194E6BD0D54EB3F430"
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively to: $SiteUrl" -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

$field = Get-PnPField -List $ListTitle -Identity "Last Verified By" -ErrorAction SilentlyContinue
if (-not $field) {
  Add-PnPField -List $ListTitle -DisplayName "Last Verified By" -InternalName "LastVerifiedBy" -Type Text -AddToDefaultView
  Write-Host "Added column 'Last Verified By'." -ForegroundColor Green
} else {
  Write-Host "Column 'Last Verified By' already exists." -ForegroundColor Yellow
}

Disconnect-PnPOnline
Write-Host "DONE." -ForegroundColor Green
