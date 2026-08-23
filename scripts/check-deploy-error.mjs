import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const res = await fetch('https://api.vercel.com/v13/deployments/dpl_Hcx45QnkngTFdWxNnaFf3toqe1Mh', {
  headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
});
console.log(res.status);
const j = await res.json();
console.log(JSON.stringify(j.errorMessage || j.error || { note: 'no error field' }, null, 1).slice(0, 800));
