# Generate a self-signed certificate for PnP non-interactive auth
# Run: pwsh -NoProfile -File .\generate-cert.ps1
#
# The pfx password is generated randomly per run and written ONCE, locally, to
# pnp-cert-pass.txt (gitignored) next to the pfx — you need it only when
# setting the SP_CERT_PASS GitHub Actions secret. It is never hardcoded and
# never committed. Delete pnp-cert-pass.txt after the secret is saved.

$ErrorActionPreference = 'Stop'

# Cryptographically random password (not stored anywhere in this repo).
# Works on both Windows PowerShell 5.1 and pwsh 7+ — RandomNumberGenerator.Fill
# is .NET Core-only, so use RNGCryptoServiceProvider (or .Create()) instead.
$bytes = New-Object byte[] 24
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$certPassword = [Convert]::ToBase64String($bytes)

$outDir      = "C:\Users\user\Xana-SharePoint"
$certPath    = Join-Path $outDir "pnp-cert.pfx"
$cerPath     = Join-Path $outDir "pnp-cert.cer"
$thumbFile   = Join-Path $outDir "pnp-cert-thumb.txt"
$passFile    = Join-Path $outDir "pnp-cert-pass.txt"

# 1) Create the cert
$cert = New-SelfSignedCertificate -DnsName "pnp" -CertStoreLocation "cert:\CurrentUser\My" -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)
Write-Output "Certificate created."
Write-Output "Thumbprint: $($cert.Thumbprint)"

# 2) Save thumbprint to file
$cert.Thumbprint | Out-File -FilePath $thumbFile -Encoding utf8

# 3) Export .pfx (private key)
$cert | Export-PfxCertificate -FilePath $certPath -Password (ConvertTo-SecureString -String $certPassword -Force -AsPlainText)
Write-Output "PFX saved to: $certPath"

# 3b) Save the pfx password locally, once, for setting the SP_CERT_PASS secret.
#     Plain text on disk — delete after the secret is saved in GitHub.
$certPassword | Out-File -FilePath $passFile -Encoding ascii -NoNewline
Write-Output "PFX password saved to: $passFile  (delete this after setting SP_CERT_PASS)"

# 4) Export .cer (public key — upload THIS to Entra)
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT
Write-Output "CER saved to: $cerPath"

Write-Output "DONE."
Write-Output "Next steps (rotation):"
Write-Output "  1. Upload $cerPath to Entra -> App reg -> pnp -> Certificates & secrets -> Certificates -> Upload."
Write-Output "  2. GitHub repo -> Settings -> Secrets and variables -> Actions:"
Write-Output "       SP_CERT_B64   = [Convert]::ToBase64String([IO.File]::ReadAllBytes('$certPath'))"
Write-Output "       SP_CERT_PASS  = contents of $passFile"
Write-Output "       SP_THUMBPRINT = $($cert.Thumbprint)"
Write-Output "  3. Run the data-health workflow manually (Run workflow) to verify, then"
Write-Output "     delete the OLD certificate from the Entra app registration."
Write-Output "The thumbprint is: $($cert.Thumbprint)"

