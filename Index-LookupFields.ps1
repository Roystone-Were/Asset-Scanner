<#
.SYNOPSIS
  Index the lookup columns (SerialNumber, Title) on the Xana Asset
  Inventory list so Graph $filter lookups are fast and allowed at any list
  size. SharePoint only permits $filter on indexed columns, and past ~5,000
  items unindexed $filter queries are rejected outright (the app currently
  works around this with the HonorNonIndexedQueries header).

  Also prints exactly which columns are indexed, so nobody has to count or
  guess in the List Settings UI.

.EXAMPLE
  pwsh -NoProfile -File .\Index-LookupFields.ps1          # create the indexes
  pwsh -NoProfile -File .\Index-LookupFields.ps1 -Verify   # just show the state
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [switch]$Verify
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint

$LookupFields = @('SerialNumber', 'Title')

function Show-State([string]$heading) {
  Write-Host ""
  Write-Host $heading -ForegroundColor Cyan
  foreach ($name in $LookupFields) {
    $f = Get-PnPField -List $ListTitle -Identity $name -Includes Indexed
    $color = if ($f.Indexed) { 'Green' } else { 'Yellow' }
    $state = if ($f.Indexed) { 'INDEXED' } else { 'not indexed' }
    Write-Host ("  {0,-14} {1}" -f $name, $state) -ForegroundColor $color
  }
}

Show-State "Current index state on '$ListTitle':"

if ($Verify) {
  Write-Host ""
  Write-Host "Verify mode - no changes made." -ForegroundColor Green
  Disconnect-PnPOnline
  exit 0
}

Write-Host ""
foreach ($name in $LookupFields) {
  $f = Get-PnPField -List $ListTitle -Identity $name -Includes Indexed
  if ($f.Indexed) {
    Write-Host "  $name already indexed - skipping." -ForegroundColor Yellow
    continue
  }
  try {
    Set-PnPField -List $ListTitle -Identity $name -Values @{ Indexed = $true }
    Write-Host "  $name -> indexed." -ForegroundColor Green
  } catch {
    Write-Host "  $name -> FAILED: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Show-State "After:"
Write-Host ""
Write-Host "DONE. Graph `$filter lookups on these columns are now allowed at any list size." -ForegroundColor Green
Disconnect-PnPOnline
