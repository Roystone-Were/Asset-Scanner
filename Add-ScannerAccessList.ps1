<#
.SYNOPSIS
  Creates the Scanner Access allowlist for the unified Xana Asset System.
  One role Allowed: if Email is in this list you can Scan + Add.
  Admin (roystone@xanalife.com) manages it via /admin UI.

.EXAMPLE
  pwsh -NoProfile -File .\Add-ScannerAccessList.ps1
  pwsh -NoProfile -File .\Add-ScannerAccessList.ps1 -Verify
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Scanner Access",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [switch]$Verify
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting to $SiteUrl ..." -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

$list = Get-PnPList -Identity $ListTitle -ErrorAction SilentlyContinue
if (-not $list) {
  if ($Verify) { Write-Host "List '$ListTitle' not found." -ForegroundColor Yellow; Disconnect-PnPOnline; exit 0 }
  Write-Host "Creating list '$ListTitle' ..." -ForegroundColor Cyan
  $list = New-PnPList -Title $ListTitle -Template GenericList -OnQuickLaunch:$false
  # Email column (indexed for fast lookup)
  Add-PnPField -List $ListTitle -DisplayName "Email" -InternalName "Email" -Type Text -AddToDefaultView | Out-Null
  # Ensure Title still exists but not used - we keep default Title for SP
  Write-Host "Indexing Email column ..." -ForegroundColor Cyan
  $f = Get-PnPField -List $ListTitle -Identity "Email" -Includes Indexed
  if (-not $f.Indexed) { Set-PnPField -List $ListTitle -Identity "Email" -Values @{ Indexed = $true } }
  # Add default admin
  $adminEmail = "roystone@xanalife.com"
  $existing = Get-PnPListItem -List $ListTitle -ErrorAction SilentlyContinue | Where-Object { $_["Email"] -ieq $adminEmail }
  if (-not $existing) {
    Add-PnPListItem -List $ListTitle -Values @{ Title = $adminEmail; Email = $adminEmail } | Out-Null
    Write-Host "Added admin $adminEmail as Allowed." -ForegroundColor Green
  }
  Write-Host "List '$ListTitle' ready." -ForegroundColor Green
} else {
  Write-Host "List '$ListTitle' already exists (Id: $($list.Id))." -ForegroundColor Green
  $f = Get-PnPField -List $ListTitle -Identity "Email" -Includes Indexed -ErrorAction SilentlyContinue
  if ($f -and -not $f.Indexed) {
    if ($Verify) { Write-Host "Email column not indexed." -ForegroundColor Yellow } else { Set-PnPField -List $ListTitle -Identity "Email" -Values @{ Indexed = $true }; Write-Host "Indexed Email column." -ForegroundColor Green }
  } else { Write-Host "Email column indexed: $($f.Indexed)" -ForegroundColor Green }
  $items = Get-PnPListItem -List $ListTitle -PageSize 500
  Write-Host "Current members ($($items.Count)):" -ForegroundColor Cyan
  $items | ForEach-Object { Write-Host ("  {0,-30} Title={1}" -f $_["Email"], $_["Title"]) }
}

if ($Verify) { Write-Host "Verify mode - no changes." -ForegroundColor Green }
Disconnect-PnPOnline
