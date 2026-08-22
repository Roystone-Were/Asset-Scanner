<#
.SYNOPSIS
  Import desktops/POS from OneDrive\Results to SharePoint Xana Asset Inventory.
  - Dedup within Results by SerialNumber+MAC
  - Skip 4 person-laptops (Brenda, Ester, Jeremiah, Roystone) and any serial already in SharePoint (no new row)
  - If Serial is just numbers => POS, else Desktop/Laptop per rules
  - Add Location/Region per your mapping, keep Title empty, no extra rows for existing

.EXAMPLE
  pwsh -NoProfile -File .\Import-ResultsToSharePoint.ps1 -DryRun
  pwsh -NoProfile -File .\Import-ResultsToSharePoint.ps1 -Push
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [string]$ResultsPath = "C:\Users\user\OneDrive - Refrontier Group\Documents\Results",
  [switch]$DryRun,
  [switch]$Push
)
$ErrorActionPreference = 'Stop'
Import-Module PnP.PowerShell

function Get-FieldV([object]$fields, [string]$name) {
  $n = ($name -replace '_x[0-9a-fA-F]{4}_', ' ' -replace '[^a-zA-Z0-9]', '')
  foreach ($k in $fields.Keys) {
    $norm = ($k -replace '_x[0-9a-fA-F]{4}_', ' ' -replace '[^a-zA-Z0-9]', '')
    if ($norm -ieq $n) { return $fields[$k] }
  }
  return $null
}

# --- 1. Read Results CSVs ---
Write-Host "Reading Results from $ResultsPath ..." -ForegroundColor Cyan
$files = Get-ChildItem -LiteralPath $ResultsPath -Filter "*_sysinfo.csv"
$rawRows = @()
foreach ($f in $files) {
  $row = Import-Csv -LiteralPath $f.FullName | Select-Object -First 1
  if (-not $row) { Write-Host "  $($f.Name) empty - skip" -ForegroundColor Yellow; continue }
  $serial = [string]$row.SerialNumber
  $serialNorm = $serial.Trim().ToUpper()
  # Skip placeholder serials (including "Default string" from some POS)
  if (-not $serialNorm -or $serialNorm -match '^[-—.\s]*$' -or $serialNorm -match '^(N/?A)$' -or $serialNorm -match '^DEFAULT STRING$') { Write-Host "  $($f.Name) serial '$serial' placeholder - skip" -ForegroundColor Yellow; continue }
  $rawRows += [pscustomobject]@{
    FileName     = $f.Name
    Serial       = $serial.Trim()
    SerialNorm   = $serialNorm
    MAC          = [string]$row.MAC
    Model        = [string]$row.Model
    Manufacturer = [string]$row.Manufacturer
    ComputerName = [string]$row.ComputerName
    Owner        = [string]$row.Owner
    FullRow      = $row
  }
}
Write-Host "Found $($rawRows.Count) rows from $($files.Count) files." -ForegroundColor Green

# --- 2. Skip 4 person-laptops explicitly ---
$skipSet = @("brenda_sysinfo.csv","ester_sysinfo.csv","jeremiah_sysinfo.csv","roystone_sysinfo.csv")
$initialCount = $rawRows.Count
$filtered = @($rawRows | Where-Object { $skipSet -notcontains $_.FileName.ToLower() })
$skippedPerson = $initialCount - $filtered.Count
if ($skippedPerson -gt 0) { Write-Host "Skipped $skippedPerson person-laptops (Brenda/Ester/Jeremiah/Roystone) per your rule." -ForegroundColor Yellow }
$rawRows = $filtered

# --- 3. Dedup within Results by SerialNorm+MAC ---
$seen = @{}
$deduped = @()
$dupInResults = @()
foreach ($r in $rawRows) {
  $key = $r.SerialNorm + "|" + $r.MAC.Trim().ToUpper()
  # also key by serial alone for till_1 duplicate (same serial different MAC last char)
  $keySerial = $r.SerialNorm
  if ($seen.ContainsKey($keySerial)) {
    $dupInResults += $r
    Write-Host "  Dup in Results: $($r.FileName) serial $($r.Serial) same as $($seen[$keySerial].FileName) - dropping $($r.FileName)" -ForegroundColor Yellow
    # Prefer keeping the file that has location hint (till_1_syokimau vs till_1) but per your rule till 1 & 3 are Ruiru, so keep Ruiru version
    # For now keep first seen which is alphabetical, but we will enforce Ruiru for till_1/3 later via location mapping
    continue
  }
  $seen[$keySerial] = $r
  $deduped += $r
}
Write-Host "After dedup: $($deduped.Count) unique serials, $($dupInResults.Count) dups dropped." -ForegroundColor Green

# --- 4. Map Location/Type/Region ---
function Get-MappedInfo([object]$r) {
  $fn = $r.FileName.ToLower()
  $serial = $r.Serial
  $isNumeric = $serial -match '^[0-9]+$'
  $manufacturer = $r.Manufacturer
  $model = $r.Model
  # Defaults
  $assetType = if ($isNumeric) { "POS" } else { if ($manufacturer -match "HP" -and $model -match "OmniBook") { "Laptop" } else { "Desktop" } }
  $location = ""
  $region = "Nairobi"
  # Per your explicit rules
  if ($fn -match "deli_syokimau") { $assetType="POS"; $location="Syokimau" }
  elseif ($fn -match "mumbi") { $assetType="Laptop"; $location="Syokimau" }
  elseif ($fn -match "vivian") { $assetType="Laptop"; $location="Syokimau" }
  elseif ($fn -match "lumumba") { $assetType="POS"; $location="Lumumba Dr" }
  elseif ($fn -match "trm") { $assetType="Desktop"; $location="TRM Dr"; $region="Nairobi" }
  elseif ($fn -match "till_1" -or $fn -match "till_3") { $assetType="POS"; $location="Ruiru" }
  elseif ($fn -match "till_2_ruiru" -or $fn -match "deli_ruiru" -or $fn -match "ruiru") { $assetType="POS"; $location="Ruiru" }
  elseif ($fn -match "katani") { $assetType="POS"; $location="Katani" }
  elseif ($fn -match "syokimau" -or $fn -match "sym") { $assetType="POS"; $location="Syokimau" }
  elseif ($fn -match "liquor" -or $fn -match "wholesale") { $assetType="POS"; $location="Syokimau" }
  # Override: TRM already set, numeric already POS, Mumbi/Vivian already Laptop
  # Ensure TRM stays Desktop per you
  if ($fn -match "trm") { $assetType="Desktop" }
  return [pscustomobject]@{ AssetType=$assetType; Location=$location; Region=$region }
}

$mapped = foreach ($r in $deduped) {
  $m = Get-MappedInfo $r
  [pscustomobject]@{
    FileName=$r.FileName; Serial=$r.Serial; SerialNorm=$r.SerialNorm; Model=$r.Model; Manufacturer=$r.Manufacturer
    AssetType=$m.AssetType; Location=$m.Location; Region=$m.Region; Owner=$r.Owner; ComputerName=$r.ComputerName
  }
}
Write-Host ""
Write-Host "Mapped assets (Location/Type):" -ForegroundColor Cyan
$mapped | Format-Table FileName, Serial, AssetType, Location, Region -AutoSize | Out-String | Write-Host

# --- 5. Connect to SharePoint and fetch existing serials (offline fallback to local fixtures) ---
$existingBySerial = @{}
$connected = $false
try {
  Write-Host "Connecting to $SiteUrl ..." -ForegroundColor Cyan
  Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
  Write-Host "Connected. Reading SharePoint serials ..." -ForegroundColor Green
  $items = Get-PnPListItem -List $ListTitle -PageSize 500
  foreach ($i in $items) {
    $f = $i.FieldValues
    $s = [string](Get-FieldV $f 'Serial Number')
    $sNorm = $s.Trim().ToUpper()
    if (-not $sNorm -or $sNorm -match '^[-—.\s]*$' -or $sNorm -match '^(N/?A)$' -or $sNorm -match '^DEFAULT STRING$') { continue }
    if (-not $existingBySerial.ContainsKey($sNorm)) { $existingBySerial[$sNorm] = $i }
  }
  $connected = $true
  Write-Host "SharePoint has $($existingBySerial.Count) items with serials." -ForegroundColor Green
} catch {
  Write-Host "Could not connect to SharePoint (offline?): $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Falling back to local fixtures for dry-run comparison ..." -ForegroundColor Yellow
  $fixture = Join-Path $PSScriptRoot "scanner-app/test/fixtures/assets.json"
  if (Test-Path $fixture) {
    $rows = Get-Content $fixture -Raw | ConvertFrom-Json
    foreach ($r in $rows) {
      $sNorm = [string]$r.serial; $sNorm = $sNorm.Trim().ToUpper()
      if (-not $sNorm -or $sNorm -match '^[-—.\s]*$' -or $sNorm -match '^(N/?A)$') { continue }
      if (-not $existingBySerial.ContainsKey($sNorm)) { $existingBySerial[$sNorm] = [pscustomobject]@{ Id=$r.id; FieldValues=@{ Title=$r.tag } } }
    }
    Write-Host "Loaded $($existingBySerial.Count) serials from fixtures/assets.json for comparison." -ForegroundColor Yellow
  } else {
    Write-Host "No fixture found - will treat all as new." -ForegroundColor Yellow
  }
}
 $toPush = @()
$toSkipExists = @()
foreach ($m in $mapped) {
  if ($existingBySerial.ContainsKey($m.SerialNorm)) {
    $existing = $existingBySerial[$m.SerialNorm]
    $tag = ""
    try { $tag = [string](Get-FieldV $existing.FieldValues 'Title') } catch { $tag = [string]$existing.Id }
    if (-not $tag) { $tag = [string]$existing.psobject.Properties['Id'].Value }
    $toSkipExists += [pscustomobject]@{ FileName=$m.FileName; Serial=$m.Serial; ExistingId=$existing.Id; ExistingTag=$tag }
  } else {
    $toPush += $m
  }
}

Write-Host ""
Write-Host "===== DRY-RUN SUMMARY =====" -ForegroundColor Cyan
Write-Host "Will PUSH (new, not in SharePoint): $($toPush.Count)" -ForegroundColor Green
if ($toPush.Count -gt 0) { $toPush | Format-Table FileName, Serial, AssetType, Location, Region -AutoSize | Out-String | Write-Host }
Write-Host "Will SKIP (already exists, no new row): $($toSkipExists.Count)" -ForegroundColor Yellow
if ($toSkipExists.Count -gt 0) { $toSkipExists | Format-Table FileName, Serial, ExistingId, ExistingTag -AutoSize | Out-String | Write-Host }
Write-Host "Dups in Results already dropped: $($dupInResults.Count)" -ForegroundColor Yellow
Write-Host "Person-laptops skipped: $skippedPerson" -ForegroundColor Yellow
Write-Host ""
Write-Host "SharePoint will remain same for existing rows - no overwrites, no extra rows." -ForegroundColor Green

if ($DryRun -or (-not $Push)) {
  Write-Host "Dry-run only. Re-run with -Push to actually insert $($toPush.Count) new items." -ForegroundColor Cyan
  if ($connected) { Disconnect-PnPOnline }
  exit 0
}

# --- 6. Push ---
Write-Host "Pushing $($toPush.Count) new items ..." -ForegroundColor Cyan
$pushed=0
foreach ($m in $toPush) {
  $fields = @{
    Title = ""  # keep Tag empty as you will fill later
    SerialNumber = $m.Serial
    Model = "$($m.Manufacturer) $($m.Model)".Trim()
    Asset = $m.AssetType
    Status = "In Use"
  }
  if ($m.Location) { $fields.Location = $m.Location }
  if ($m.Region) { $fields.Region = $m.Region }
  if ($m.Owner) { $fields.EmployeeName = $m.Owner }
  try {
    $new = Add-PnPListItem -List $ListTitle -Values $fields
    Write-Host "  Pushed $($m.FileName) Serial $($m.Serial) -> Asset #$($new.Id) ($($m.AssetType) at $($m.Location))" -ForegroundColor Green
    $pushed++
  } catch {
    Write-Host "  FAILED $($m.FileName) Serial $($m.Serial): $($_.Exception.Message)" -ForegroundColor Red
  }
}
Write-Host "Done. Pushed $pushed / $($toPush.Count)." -ForegroundColor Green
if ($connected) { Disconnect-PnPOnline }
