<#
.SYNOPSIS
  Email the data-health report to an address of your choice via SMTP (STARTTLS).
  Called by .github/workflows/data-health.yml after the report is generated,
  so the monthly report reaches you even if you don't check GitHub.

  Any SMTP provider works - just set the host/port/credentials. For Gmail:
  host smtp.gmail.com, port 587, user = your Gmail address, password = an
  App Password (needs 2-Step Verification on the Google account, generated at
  https://myaccount.google.com/apppasswords).

.EXAMPLE
  pwsh -NoProfile -File .\Send-HealthEmail.ps1 -ReportPath health-report.md `
    -SmtpHost smtp.gmail.com -SmtpPort 587 -SmtpUser me@gmail.com `
    -SmtpPass "xxxx xxxx xxxx xxxx" -MailTo me@gmail.com
#>
param(
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][string]$SmtpHost,
  [Parameter(Mandatory = $true)][int]$SmtpPort,
  [Parameter(Mandatory = $true)][string]$SmtpUser,
  [Parameter(Mandatory = $true)][string]$SmtpPass,
  [Parameter(Mandatory = $true)][string]$MailTo,
  [string]$MailSubject = "Xana Asset Inventory - Data Health Report"
)
$ErrorActionPreference = 'Stop'

# Body = the report without the GitHub "@mention" line that the workflow adds
# for the issue (it reads oddly in a plain email).
$body = [regex]::Replace(
  (Get-Content $ReportPath -Raw),
  '^cc\s+@[^\r\n]*(\r?\n)?',
  ''
)

$msg = New-Object System.Net.Mail.MailMessage($SmtpUser, $MailTo, $MailSubject, $body)
$msg.Attachments.Add((New-Object System.Net.Mail.Attachment($ReportPath)))

$client = New-Object System.Net.Mail.SmtpClient($SmtpHost, $SmtpPort)
$client.EnableSsl = $true
$client.Credentials = New-Object System.Net.NetworkCredential($SmtpUser, $SmtpPass)
$client.Send($msg)

$msg.Dispose()
$client.Dispose()
Write-Host "Email sent to $MailTo via ${SmtpHost}:${SmtpPort}" -ForegroundColor Green
