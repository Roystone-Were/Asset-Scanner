<#
.SYNOPSIS
  Monthly data-health check for the Xana Asset Inventory list. Reports:
    - items with a duplicate serial number or barcode
    - items with no tag (Title) or no serial
    - items not verified in the last 90 days (uses Last Verified)
    - missing/renamed columns
    - client certificate expiring within 90 days
    - a status summary

  Runs on demand locally (pwsh -NoProfile -File .\Health-Check.ps1) or on a
  schedule in GitHub Actions (see .github/workflows/data-health.yml, which
  files an issue whenever "## Issues found" is present in the report).

.EXAMPLE
  pwsh -NoProfile -File .\Health-Check.ps1 -OutReport health-report.md
#>
param(
  [string]$SiteUrl    = "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData",
  [string]$ListTitle  = "Xana Asset Inventory",
  [string]$ClientId   = "7caa51af-9f32-42d8-8264-da5b97c2f8eb",
  [string]$Tenant     = "refrontiergroup.onmicrosoft.com",
  [string]$Thumbprint = "B4437765C89E84AE84B813194E6BD0D54EB3F430",
  [int]$StaleDays     = 90,
  [string]$OutReport  = "health-report.md",
  # Optional: write a machine-readable metrics snapshot (used by the GitHub
  # workflow to maintain health-history.json for month-over-month deltas).
  [string]$OutMetrics = "",
  # Optional: previous metrics JSON - when present the report gains a
  # "vs last report" section (score/stale/untagged/noSerial deltas).
  [string]$PrevMetrics = ""
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
  $serial = [string](Get-FieldV $f 'Serial Number')
  # Placeholder-only serials ("-", "—", "N/A", spaces) count as missing -
  # otherwise six rows with "-" read as one big duplicate-serial group.
  if ($serial -match '^[-—.\s]*$' -or $serial -match '^(n/?a)$') { $serial = '' }
  [pscustomobject]@{
    id       = [int]$i.Id
    tag      = [string]$tag
    model    = [string](Get-FieldV $f 'Model')
    serial   = $serial
    barcode  = [string](Get-FieldV $f 'Barcode')
    status   = [string](Get-FieldV $f 'Status')
    location = [string](Get-FieldV $f 'Location')
    verified = Get-FieldV $f 'Last Verified'
    verifiedby = [string](Get-FieldV $f 'Last Verified By')
  }
}
$rows = @($rows | Sort-Object id)

# --- Health score + headline metrics ---
# An asset is "clean" when it has a tag, a serial, a fresh verification and
# no duplicate keys. The score is the share of clean assets - the one number
# leadership reads first, tracked month-over-month via -PrevMetrics.
$cutoff = (Get-Date).AddDays(-$StaleDays)
$dupSerialIds = @{}
$bySerialPre = $rows | Where-Object { $_.serial } | Group-Object { $_.serial.Trim().ToUpper() }
foreach ($g in ($bySerialPre | Where-Object { $_.Count -gt 1 })) {
  foreach ($r in $g.Group) { $dupSerialIds[[int]$r.id] = $true }
}
$dupBarcodeIds = @{}
$byBarcodePre = $rows | Where-Object { $_.barcode } | Group-Object { $_.barcode.Trim().ToUpper() }
foreach ($g in ($byBarcodePre | Where-Object { $_.Count -gt 1 })) {
  foreach ($r in $g.Group) { $dupBarcodeIds[[int]$r.id] = $true }
}
$clean = @($rows | Where-Object {
  $_.tag.Trim() -and $_.serial.Trim() -and $_.verified -and $_.verified -ge $cutoff -and
  -not $dupSerialIds.ContainsKey([int]$_.id) -and -not $dupBarcodeIds.ContainsKey([int]$_.id)
})
$score = if ($rows.Count) { [int][Math]::Round(100 * $clean.Count / $rows.Count) } else { 0 }
$staleCount = @($rows | Where-Object { -not $_.verified -or $_.verified -lt $cutoff }).Count
$noTagCount = @($rows | Where-Object { -not $_.tag.Trim() }).Count
$noSerialCount = @($rows | Where-Object { -not $_.serial.Trim() }).Count

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("# Xana Asset Inventory - Data Health Report")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm') UTC")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("**Total assets: $($rows.Count)**")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("**Health score: $score%** — $($clean.Count) of $($rows.Count) assets fully clean (tagged, serial present, verified within $StaleDays days, no duplicate keys).")
[void]$sb.AppendLine("")

if ($PrevMetrics -and (Test-Path $PrevMetrics)) {
  try {
    $prev = Get-Content $PrevMetrics -Raw | ConvertFrom-Json
    function Format-Delta([string]$label, [object]$from, [object]$to, [switch]$HigherIsBetter) {
      $d = [int]$to - [int]$from
      if ($d -eq 0) { return "- ${label}: unchanged ($to)" }
      $arrow = if ($d -gt 0) { "▲" } else { "▼" }
      $good = if ($HigherIsBetter) { $d -gt 0 } else { $d -lt 0 }
      $tone = if ($good) { ":white_check_mark:" } else { ":warning:" }
      return "- ${label}: $from → $to ($arrow$([Math]::Abs($d))) $tone"
    }
    [void]$sb.AppendLine("### vs last report")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine((Format-Delta "Health score" $prev.score $score -HigherIsBetter))
    [void]$sb.AppendLine((Format-Delta "Unverified $StaleDays+ days" $prev.stale $staleCount))
    [void]$sb.AppendLine((Format-Delta "Untagged" $prev.untagged $noTagCount))
    [void]$sb.AppendLine((Format-Delta "Missing serials" $prev.noSerial $noSerialCount))
    [void]$sb.AppendLine("")
  } catch {
    Write-Host "Could not compare against previous metrics: $_" -ForegroundColor Yellow
  }
}

$issues = 0
function Add-Issue([string]$title, [string]$body) {
  $script:issues++
  [void]$script:sb.AppendLine("## $title")
  [void]$script:sb.AppendLine("")
  [void]$script:sb.AppendLine($body)
  [void]$script:sb.AppendLine("")
}

# --- Duplicate serials ---
$bySerial = $rows | Where-Object { $_.serial } | Group-Object { $_.serial.Trim().ToUpper() }
$dups = $bySerial | Where-Object { $_.Count -gt 1 }
if ($dups) {
  $lines = foreach ($d in $dups) {
    $ids = ($d.Group | ForEach-Object { "Asset #$($_.id) ($($_.tag))" }) -join ', '
    "- **$($d.Name)**: $ids"
  }
  Add-Issue "Duplicate serial numbers" ($lines -join "`n")
} else {
  [void]$sb.AppendLine("No duplicate serial numbers. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Duplicate barcodes (a shared barcode returns the wrong asset silently) ---
$byBarcode = $rows | Where-Object { $_.barcode } | Group-Object { $_.barcode.Trim().ToUpper() }
$bDups = $byBarcode | Where-Object { $_.Count -gt 1 }
if ($bDups) {
  $lines = foreach ($d in $bDups) {
    $ids = ($d.Group | ForEach-Object { "Asset #$($_.id) ($($_.tag))" }) -join ', '
    "- **$($d.Name)**: $ids"
  }
  Add-Issue "Duplicate barcodes" ($lines -join "`n")
} else {
  [void]$sb.AppendLine("No duplicate barcodes. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Empty tags ---
$noTag = @($rows | Where-Object { -not $_.tag.Trim() })
if ($noTag.Count -gt 0) {
  $ids = ($noTag | ForEach-Object { "Asset #$($_.id)" }) -join ', '
  Add-Issue "Assets with no tag (Title)" "$($noTag.Count) assets have no tag: $ids"
} else {
  [void]$sb.AppendLine("All assets have a tag. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Empty serials ---
$noSerial = @($rows | Where-Object { -not $_.serial.Trim() })
if ($noSerial.Count -gt 0) {
  $ids = ($noSerial | ForEach-Object {
    $bits = @()
    if ($_.tag.Trim()) { $bits += $_.tag.Trim() }
    if ($_.model.Trim()) { $bits += "model $($_.model.Trim())" }
    if ($bits.Count -gt 0) { "Asset #$($_.id) ($($bits -join ' · '))" } else { "Asset #$($_.id)" }
  }) -join ', '
  Add-Issue "Assets with no serial number" "$($noSerial.Count) assets have no serial: $ids"
} else {
  [void]$sb.AppendLine("All assets have a serial number. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Stale (not verified in N days) ---
$cutoff = (Get-Date).AddDays(-$StaleDays)
$stale = @($rows | Where-Object { -not $_.verified -or $_.verified -lt $cutoff })
if ($stale.Count -gt 0) {
  function ConvertTo-MdCell([string]$v) {
    if (-not $v.Trim()) { return '—' }
    return $v.Trim() -replace '\|', '\\|' -replace "`n", ' '
  }
  $hdr = '| Asset | Tag | Model | Serial | Last verified | Verified by |'
  $sep = '|---|---|---|---|---|---|'
  $lines = foreach ($s in $stale) {
    $v = if ($s.verified) { $s.verified.ToString('yyyy-MM-dd') } else { 'never' }
    '| #{0} | {1} | {2} | {3} | {4} | {5} |' -f $s.id,
      (ConvertTo-MdCell $s.tag),
      (ConvertTo-MdCell $s.model),
      (ConvertTo-MdCell $s.serial),
      $v,
      (ConvertTo-MdCell $s.verifiedby)
  }
  $table = "$hdr`n$sep`n$($lines -join "`n")"
  Add-Issue "Assets not verified in the last $StaleDays days" "$($stale.Count) assets:`n`n$table"
} else {
  [void]$sb.AppendLine("All assets verified within the last $StaleDays days. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Schema check (a renamed/deleted column breaks the app + scripts) ---
$expectedFields = @('Title', 'Asset Tag', 'Serial Number', 'Barcode', 'Model', 'Status', 'Location', 'Last Verified', 'Last Verified By')
$missingFields = @()
foreach ($fname in $expectedFields) {
  if (-not (Get-PnPField -List $ListTitle -Identity $fname -ErrorAction SilentlyContinue)) {
    $missingFields += $fname
  }
}
if ($missingFields.Count -gt 0) {
  Add-Issue "Missing or renamed columns" "The app and scripts expect these columns, but they could not be found on the list: $($missingFields -join ', ')"
} else {
  [void]$sb.AppendLine("All expected columns present. :white_check_mark:")
  [void]$sb.AppendLine("")
}

# --- Client certificate expiry (silent auth loss when it lapses) ---
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -ieq $Thumbprint } | Select-Object -First 1
if ($cert) {
  $daysLeft = [int]($cert.NotAfter - (Get-Date)).TotalDays
  if ($daysLeft -lt 90) {
    Add-Issue "Client certificate expires soon" "The automation certificate (thumbprint $Thumbprint) expires on $($cert.NotAfter.ToString('yyyy-MM-dd')) ($daysLeft days left). Rotate it before then or every script + the GitHub workflow silently loses auth."
  } else {
    [void]$sb.AppendLine("Client certificate OK - expires $($cert.NotAfter.ToString('yyyy-MM-dd')) ($daysLeft days left). :white_check_mark:")
    [void]$sb.AppendLine("")
  }
}

# --- Status summary ---
[void]$sb.AppendLine("## Status summary")
[void]$sb.AppendLine("")
$rows | Group-Object { $_.status } | Sort-Object Name | ForEach-Object {
  [void]$sb.AppendLine("- $($_.Name): $($_.Count)")
}
[void]$sb.AppendLine("")

if ($issues -gt 0) {
  [void]$sb.AppendLine("## Issues found")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("$issues issue(s) above need attention.")
  [void]$sb.AppendLine("")
}

$report = $sb.ToString()
$report | Out-File $OutReport -Encoding UTF8

if ($OutMetrics) {
  $metrics = [pscustomobject]@{
    generated   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    totalAssets = $rows.Count
    clean       = $clean.Count
    score       = $score
    untagged    = $noTagCount
    noSerial    = $noSerialCount
    stale       = $staleCount
    dupSerials  = @($bySerialPre | Where-Object { $_.Count -gt 1 }).Count
    dupBarcodes = @($byBarcodePre | Where-Object { $_.Count -gt 1 }).Count
  }
  $metrics | ConvertTo-Json | Out-File $OutMetrics -Encoding UTF8
  Write-Host "Metrics saved to $OutMetrics" -ForegroundColor Green
}

Write-Host ""
Write-Host "REPORT" -ForegroundColor Cyan
Write-Host $report
Write-Host "Saved to $OutReport" -ForegroundColor Green

Disconnect-PnPOnline
