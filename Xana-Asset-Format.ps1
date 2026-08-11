<#
.SYNOPSIS
  Apply JSON color formatting to the "Status" column and row highlighting in the
  Xana Asset Inventory SharePoint list, via PnP PowerShell.

.EXAMPLE
  pwsh -NoProfile -File .\Xana-Asset-Format.ps1
  # A browser window opens - sign in with your Refrontier/Entra account (MFA).
  # Then the script reads your real Status choices and applies the formatting.

.NOTES
  Requires PnP.PowerShell (already installed) and PowerShell 7 (already installed).
  It is SAFE/idempotent: it only updates formatting, it does not delete or edit rows.
#>
param(
  [string]$SiteUrl      = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle    = "Xana Asset Inventory",
  [string]$StatusColumn = "Status",
  [string]$ViewName     = "All Items",
  [string]$ClientId     = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant       = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint   = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [switch]$SkipRowFormat
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

Write-Host "Connecting non-interactively to: $SiteUrl" -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
Write-Host "Connected." -ForegroundColor Green

# ---- Read the real Status field + its choices ----
$list  = Get-PnPList -Identity $ListTitle
Write-Host "List found: $($list.Title)" -ForegroundColor Green

$field = Get-PnPField -List $ListTitle -Identity $StatusColumn
if (-not $field) { throw "Column '$StatusColumn' not found on '$ListTitle'." }
$choices = @($field.Choices)
if ($choices.Count -eq 0) { throw "'$StatusColumn' has no choices - is it a Choice column? Confirm the exact column name." }
Write-Host "Status choices found: $($choices -join ', ')" -ForegroundColor Cyan

# Map known statuses -> colors. Anything else defaults to blue.
$palette = @{
  'In Use'      = '#107c10'  # green
  'Active'      = '#107c10'
  'Available'   = '#ff8c00'  # orange
  'In Stock'    = '#ff8c00'
  'Under Repair'= '#d13438'  # red
  'Broken'      = '#d13438'
  'Lost'        = '#c50f1f'  # dark red
  'Retired'     = '#605e5c'  # grey
}
$matched = @()
$expr = ''
foreach ($c in $choices) {
  if ($palette.ContainsKey($c)) {
    $matched += $c
    if ($expr -eq '') { $expr = "=if(@currentField=='$c','$($palette[$c])'" }
    else              { $expr += ", if(@currentField=='$c','$($palette[$c])'" }
  }
}
if ($expr -eq '') { throw "None of the Status choices ($($choices -join ', ')) matched the palette. Edit `$palette in this script." }
$n = $matched.Count
$expr += ", '#0078d4')" + (')' * $n)   # default (blue), then close each nested if

# ---- Build column-formatting JSON ----
$columnJson = @{
  '$schema'   = 'https://developer.microsoft.com/json-schemas/sp/column-formatting.schema.json'
  'elmType'   = 'span'
  'style'     = @{
    'display'          = 'inline-block'
    'padding'          = '6px 12px'
    'border-radius'    = '12px'
    'font-weight'      = 'bold'
    'color'            = 'white'
    'background-color' = $expr
  }
  'txtContent' = '@currentField'
} | ConvertTo-Json -Depth 6

Write-Host "Applying column formatting to '$StatusColumn' ..." -ForegroundColor Cyan
$field.ClientSideComponentProperties = $columnJson
$field.Update()
Invoke-PnPQuery
Write-Host "Column formatting applied." -ForegroundColor Green

# ---- Optional: whole-row highlighting on a view ----
if (-not $SkipRowFormat) {
  $internal = $field.InternalName
  $rows = @($choices | Where-Object { $palette.ContainsKey($_) -and $_ -in @('Under Repair','Broken','Lost','Available','In Stock') })
  if ($rows.Count -gt 0) {
    $rowExpr = ''
    $first = $true
    foreach ($r in $rows) {
      $sev = if ($r -match 'Available|In Stock') { 'sp-field-severity--warning' } else { 'sp-field-severity--severeWarning' }
      $cond = "[`$$internal]=='$r'"
      $rowExpr = if ($first) { "=if($cond,'$sev'" } else { "$rowExpr, if($cond,'$sev'" }
      $first = $false
    }
    $rowExpr += ",'')" + (')' * $rows.Count)
    $rowJson = @{
      '$schema'            = 'https://developer.microsoft.com/json-schemas/sp/view-formatting.schema.json'
      'additionalRowClass' = $rowExpr
    } | ConvertTo-Json -Depth 4
    Write-Host "Applying row highlighting to view '$ViewName' ..." -ForegroundColor Cyan
    $view = Get-PnPView -List $ListTitle -Identity $ViewName -ErrorAction Stop
    $view.CustomFormatter = $rowJson
    $view.Update()
    Invoke-PnPQuery
    Write-Host "Row highlighting applied to view '$ViewName'." -ForegroundColor Green
  } else {
    Write-Host "No row-level colors to apply (no repair/available statuses matched)." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "DONE. Refresh the list in your browser to see the colors." -ForegroundColor Green
Disconnect-PnPOnline
