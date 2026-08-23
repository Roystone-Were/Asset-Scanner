import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const base = 'https://api.supabase.com/v1/projects/irqrnyixizzorvfmtvag/config/auth';
const res = await fetch(base, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } });
if (!res.ok) { console.error('HTTP', res.status, await res.text()); process.exit(1); }
const c = await res.json();
console.log(JSON.stringify({
  site_url: c.site_url,
  uri_allow_list: c.uri_allow_list,
  external_email_enabled: c.external_email_enabled,
  mailer_autoconfirm: c.mailer_autoconfirm,
  smtp_host: c.smtp?.smtp_host ?? null,
  smtp_port: c.smtp?.smtp_port ?? null,
  smtp_sender_name: c.smtp?.smtp_sender_name ?? null,
  mailer_otp_exp: c.mailer_otp_exp,
}, null, 1));
