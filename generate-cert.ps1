# Generate a self-signed certificate for PnP non-interactive auth
# Run: pwsh -NoProfile -File .\generate-cert.ps1

$ErrorActionPreference = 'Stop'
$certPassword = "pnp123"
$certPath    = "C:\Users\user\Xana-SharePoint\pnp-cert.pfx"
$cerPath     = "C:\Users\user\Xana-SharePoint\pnp-cert.cer"
$thumbFile   = "C:\Users\user\Xana-SharePoint\pnp-cert-thumb.txt"

# 1) Create the cert
$cert = New-SelfSignedCertificate -DnsName "pnp" -CertStoreLocation "cert:\CurrentUser\My" -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)
Write-Output "Certificate created."
Write-Output "Thumbprint: $($cert.Thumbprint)"

# 2) Save thumbprint to file
$cert.Thumbprint | Out-File -FilePath $thumbFile -Encoding utf8

# 3) Export .pfx (private key)
$cert | Export-PfxCertificate -FilePath $certPath -Password (ConvertTo-SecureString -String $certPassword -Force -AsPlainText)
Write-Output "PFX saved to: $certPath"

# 4) Export .cer (public key — upload THIS to Entra)
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT
Write-Output "CER saved to: $cerPath"

Write-Output "DONE."
Write-Output "Next: Upload $cerPath to Entra -> App reg -> pnp -> Certificates & secrets -> Certificates -> Upload."
Write-Output "The thumbprint is: $($cert.Thumbprint)"

