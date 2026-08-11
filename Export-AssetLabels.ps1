<#
.SYNOPSIS
  Export the Xana Asset Inventory items (Id + key columns) so we can generate
  QR asset labels. Uses the silent certificate connection.

.EXAMPLE
  pwsh -NoProfile -File .\Export-AssetLabels.ps1
#>
param(
  [string]$SiteUrl      = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle    = "Xana Asset Inventory",
  [string]$ClientId     = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant       = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint   = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$OutCsv       = "C:\Users\user\Xana-SharePoint\scanner-app\assets.csv",
  [string]$OutJson      = "C:\Users\user\Xana-SharePoint\scanner-app\assets.json"
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
  # The 'Asset Type' column's internal name is 'Asset' (column was renamed
  # at some point; internal names never change).
  $assetType = Get-FieldV $f 'Asset Type'
  if (-not $assetType) { $assetType = Get-FieldV $f 'Asset' }
  [pscustomobject]@{
    ItemId   = $i.Id
    AssetTag = $tag
    AssetType = $assetType
    Model    = Get-FieldV $f 'Model'
    Serial   = Get-FieldV $f 'Serial Number'
    Employee = Get-FieldV $f 'Employee Name'
    Status   = Get-FieldV $f 'Status'
    Location = Get-FieldV $f 'Location'
    URL      = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData/Lists/Xana%20Asset%20Inventory/DispForm.aspx?ID=$($i.Id)"
  }
}
$rows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8
$rows | ConvertTo-Json -Depth 3 | Out-File $OutJson -Encoding UTF8
Write-Host "Exported $($rows.Count) assets -> $OutCsv / $OutJson" -ForegroundColor Green

Write-Host ""; Write-Host "Assets:" -ForegroundColor Cyan
$rows | Format-Table -AutoSize
Disconnect-PnPOnline