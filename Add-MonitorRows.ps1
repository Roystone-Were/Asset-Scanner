<#
.SYNOPSIS
  Create Monitor rows as separate assets for CPU hosts just added.
  - Parse Monitor(s) column from Results CSVs (split by "|", extract Model + SN)
  - Only for hosts where Asset is CPU and monitor SN is real (not 0/blank)
  - Cross-check SharePoint SerialNumber to skip existing monitors
  - Copy Location/Region/Employee/Status from host, Title stays empty

.EXAMPLE
  pwsh -NoProfile -File .\Add-MonitorRows.ps1 -DryRun
  pwsh -NoProfile -File .\Add-MonitorRows.ps1 -Push
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
$ErrorActionPreference='Stop'
Import-Module PnP.PowerShell

function Get-FieldV([object]$fields,[string]$name){
  $n=($name -replace '_x[0-9a-fA-F]{4}_',' ' -replace '[^a-zA-Z0-9]','')
  foreach($k in $fields.Keys){$norm=($k -replace '_x[0-9a-fA-F]{4}_',' ' -replace '[^a-zA-Z0-9]','');if($norm -ieq $n){return $fields[$k]}}
  return $null
}

Write-Host "Reading Results Monitor(s)..." -ForegroundColor Cyan
$files=Get-ChildItem -LiteralPath $ResultsPath -Filter "*_sysinfo.csv"
$monitorCandidates=@()
foreach($f in $files){
  $row=Import-Csv -LiteralPath $f.FullName | Select-Object -First 1
  if(-not $row){continue}
  $serial=[string]$row.SerialNumber
  if(-not $serial.Trim() -or $serial.Trim().ToUpper() -match '^DEFAULT STRING$'){continue}
  $monRaw=[string]$row.'Monitor(s)'
  if(-not $monRaw){continue}
  $parts=$monRaw -split '\|'
  foreach($p in $parts){
    $pp=$p.Trim()
    if(-not $pp){continue}
    # Extract SN after "SN:"
    $m=$pp | Select-String -Pattern 'SN\s*:\s*([^\s]+)' 
    if(-not $m){continue}
    $sn=$m.Matches[0].Groups[1].Value.Trim()
    $snNorm=$sn.Trim().ToUpper()
    if(-not $snNorm -or $snNorm -match '^0+$' -or $snNorm -match '^N/?A$' -or $snNorm -match '^-+$'){continue}
    # Model is before "SN:"
    $model=$pp.Split("SN:")[0].Trim()
    # Clean model like "HPN HP P24v G5" -> keep as is, or "LEN D19-10"
    if(-not $model){$model="Monitor"}
    $monitorCandidates+= [pscustomobject]@{
      HostFile=$f.Name; HostSerial=$serial.Trim(); HostSerialNorm=$serial.Trim().ToUpper()
      MonitorModel=$model; MonitorSerial=$sn.Trim(); MonitorSerialNorm=$snNorm
      Owner=[string]$row.Owner
    }
  }
}
# Filter to only hosts that are among the 9 just added and are CPU per your rule (HP Tower) - i.e., those with real monitor
# We will filter to the 4 known CPU hosts per earlier analysis, but generic: keep only where monitor serial is real (already)
# Further filter: only hosts where HostSerial is among the 9 just pushed (or any CPU host)
$allowedHosts=@('4CE524BWFX','4CE524BWFK','4CE524BWC4','4CE513CWFN') # the 4 CPU hosts
$monitorCandidates=$monitorCandidates | Where-Object { $allowedHosts -contains $_.HostSerialNorm }
Write-Host "Found $($monitorCandidates.Count) real monitors from CPU hosts (after filtering 4 CPUs)." -ForegroundColor Green
$monitorCandidates | Format-Table HostFile,HostSerial,MonitorSerial,MonitorModel -AutoSize | Out-String | Write-Host

# Connect and fetch SharePoint
$existingBySerial=@{}
$hostBySerial=@{}
$connected=$false
try{
  Write-Host "Connecting to $SiteUrl ..." -ForegroundColor Cyan
  Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Tenant $Tenant -Thumbprint $Thumbprint
  Write-Host "Connected. Reading SharePoint serials..." -ForegroundColor Green
  $items=Get-PnPListItem -List $ListTitle -PageSize 500
  foreach($i in $items){
    $s=[string](Get-FieldV $i.FieldValues 'Serial Number'); $sNorm=$s.Trim().ToUpper()
    if(-not $sNorm -or $sNorm -match '^[-—.\s]*$' -or $sNorm -match '^(N/?A)$' -or $sNorm -match '^DEFAULT STRING$'){continue}
    if(-not $existingBySerial.ContainsKey($sNorm)){ $existingBySerial[$sNorm]=$i }
    # also map host by serial for copying fields
    $hostBySerial[$sNorm]=$i
  }
  $connected=$true
  Write-Host "SharePoint has $($existingBySerial.Count) serials." -ForegroundColor Green
}catch{
  Write-Host "Could not connect: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Falling back to fixtures for dry-run..." -ForegroundColor Yellow
  $fixture=Join-Path $PSScriptRoot "scanner-app/test/fixtures/assets.json"
  if(Test-Path $fixture){
    $rows=Get-Content $fixture -Raw | ConvertFrom-Json
    foreach($r in $rows){$sNorm=[string]$r.serial; $sNorm=$sNorm.Trim().ToUpper(); if($sNorm -and -not $existingBySerial.ContainsKey($sNorm)){ $existingBySerial[$sNorm]=[pscustomobject]@{Id=$r.id;FieldValues=@{Title=$r.tag}} }}
    Write-Host "Loaded $($existingBySerial.Count) from fixtures." -ForegroundColor Yellow
  }
}

$toCreate=@(); $toSkip=@()
foreach($m in $monitorCandidates){
  if($existingBySerial.ContainsKey($m.MonitorSerialNorm)){
    $ex=$existingBySerial[$m.MonitorSerialNorm]
    $toSkip+= [pscustomobject]@{ MonitorSerial=$m.MonitorSerial; MonitorModel=$m.MonitorModel; HostFile=$m.HostFile; HostSerial=$m.HostSerial; ExistingId=$ex.Id }
  } else {
    # get host fields to copy Location/Region/Employee/Status
    $hostItem=$hostBySerial[$m.HostSerialNorm]
    $loc=""; $reg=""; $emp=""; $status="In Use"
    if($hostItem){
      $loc=[string](Get-FieldV $hostItem.FieldValues 'Location'); $reg=[string](Get-FieldV $hostItem.FieldValues 'Region'); $emp=[string](Get-FieldV $hostItem.FieldValues 'Employee Name'); $status=[string](Get-FieldV $hostItem.FieldValues 'Status')
      if(-not $status){$status="In Use"}
    }
    # fallback from mapping: use host file location
    if(-not $loc){ $loc="Syokimau"; if($m.HostFile -match "Ruiru"){$loc="Ruiru"} elseif($m.HostFile -match "Katani"){$loc="Katani"} elseif($m.HostFile -match "lumumba"){$loc="Lumumba Dr"} }
    $toCreate+= [pscustomobject]@{
      HostFile=$m.HostFile; HostSerial=$m.HostSerial; MonitorSerial=$m.MonitorSerial; MonitorModel=$m.MonitorModel
      Location=$loc; Region=$reg; Employee=$emp; Status=$status
    }
  }
}

Write-Host ""
Write-Host "===== DRY-RUN SUMMARY =====" -ForegroundColor Cyan
Write-Host "Will CREATE monitor rows (separate, not in SharePoint): $($toCreate.Count)" -ForegroundColor Green
if($toCreate.Count -gt 0){ $toCreate | Format-Table HostFile,MonitorSerial,MonitorModel,Location,Region,Employee -AutoSize | Out-String | Write-Host }
Write-Host "Will SKIP (monitor already exists): $($toSkip.Count)" -ForegroundColor Yellow
if($toSkip.Count -gt 0){ $toSkip | Format-Table MonitorSerial,HostFile,ExistingId -AutoSize | Out-String | Write-Host }
Write-Host "SharePoint hosts not overwritten - only new monitor rows." -ForegroundColor Green

if($DryRun -or (-not $Push)){
  Write-Host "Dry-run only. Re-run with -Push to create $($toCreate.Count) monitors." -ForegroundColor Cyan
  if($connected){Disconnect-PnPOnline}
  exit 0
}

Write-Host "Creating $($toCreate.Count) monitors..." -ForegroundColor Cyan
$pushed=0
foreach($m in $toCreate){
  $fields=@{
    Title=""
    SerialNumber=$m.MonitorSerial
    Model=$m.MonitorModel
    Asset="Monitor"
    Status=$m.Status
  }
  if($m.Location){$fields.Location=$m.Location}
  if($m.Region){$fields.Region=$m.Region}
  if($m.Employee){$fields.EmployeeName=$m.Employee}
  try{
    $new=Add-PnPListItem -List $ListTitle -Values $fields
    Write-Host "  Created $($m.MonitorModel) SN $($m.MonitorSerial) -> Asset #$($new.Id) (from host $($m.HostSerial) at $($m.Location))" -ForegroundColor Green
    $pushed++
  }catch{ Write-Host "  FAILED $($m.MonitorSerial): $($_.Exception.Message)" -ForegroundColor Red }
}
Write-Host "Done. Created $pushed / $($toCreate.Count) monitors." -ForegroundColor Green
if($connected){Disconnect-PnPOnline}
