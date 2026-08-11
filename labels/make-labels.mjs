// make-labels.mjs — generate a printable QR asset-label sheet from assets.json
// Run: node make-labels.mjs
import QRCode from 'qrcode';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = JSON.parse(readFileSync(join(here, 'assets.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let labelsHtml = '';
for (const a of assets) {
  const qr = await QRCode.toDataURL(a.URL, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
  const main = a.AssetTag || a.Serial || a.Model || `Item ${a.ItemId}`;
  const sub = [a.Model, a.Serial].filter(Boolean).join(' · ');
  labelsHtml += `
    <div class="label">
      <div class="qr"><img src="${qr}" alt="${esc(a.URL)}"></div>
      <div class="meta">
        <div class="tag">${esc(main)}</div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        <div class="tiny">Scan to view in SharePoint</div>
      </div>
    </div>`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Xana Asset QR Labels</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
  .label {
    border: 1px solid #bbb; border-radius: 4px; padding: 4mm;
    display: flex; align-items: center; gap: 4mm; break-inside: avoid;
  }
  .qr img { width: 26mm; height: 26mm; display: block; }
  .meta { min-width: 0; }
  .tag { font-size: 12px; font-weight: 700; word-break: break-word; }
  .sub { font-size: 10px; color: #444; word-break: break-word; margin-top: 1mm; }
  .tiny { font-size: 7px; color: #888; margin-top: 1mm; }
  @media print {
    h1 { display: none; }
    body { margin: 0; }
  }
</style>
</head>
<body>
  <h1>Xana Asset QR Labels — ${assets.length} assets (scan a QR to open the asset in SharePoint)</h1>
  <div class="grid">${labelsHtml}
  </div>
</body>
</html>`;

writeFileSync(join(here, 'asset-labels.html'), html, 'utf8');
console.log(`Wrote asset-labels.html with ${assets.length} QR labels.`);
console.log(`Per-asset PNGs folder: ${here}`);