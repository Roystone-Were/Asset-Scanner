// Configures custom SMTP (Mailgun) + the branded Magic Link and Invite email
// templates via the Supabase Management API. Same pattern as
// apply-migration.mjs / check-auth-config.mjs.
//
// Requires these in .env.local (in addition to the existing SUPABASE_* vars):
//   MAILGUN_SMTP_USER=postmaster@mg.xanalife.com   (Mailgun > Sending > Domains > <domain> > SMTP credentials)
//   MAILGUN_SMTP_PASS=<smtp password from that same page — NOT your Mailgun API key>
//   MAILGUN_SENDER_EMAIL=noreply@xanalife.com      (must be a verified sender/domain in Mailgun)
//   MAILGUN_SENDER_NAME=Xana Asset System
// Optional:
//   MAILGUN_SMTP_HOST=smtp.mailgun.org             (use smtp.eu.mailgun.org for an EU-region domain)
//   MAILGUN_SMTP_PORT=587
//
// Usage: node scripts/set-smtp-and-template.mjs
import fs from 'fs';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const projectRef = env.SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
const required = ['SUPABASE_ACCESS_TOKEN', 'MAILGUN_SMTP_USER', 'MAILGUN_SMTP_PASS', 'MAILGUN_SENDER_EMAIL', 'MAILGUN_SENDER_NAME'];
const missing = required.filter((k) => !env[k]) .concat(projectRef ? [] : ['SUPABASE_URL (unparseable)']);
if (missing.length) {
  console.error('Missing in .env.local:', missing.join(', '));
  process.exit(1);
}

const magicLinkHtml = fs.readFileSync('scripts/email-templates/magic-link.html', 'utf8');
const inviteHtml = fs.readFileSync('scripts/email-templates/invite.html', 'utf8');

const body = {
  external_email_enabled: true,

  smtp_host: env.MAILGUN_SMTP_HOST || 'smtp.mailgun.org',
  smtp_port: env.MAILGUN_SMTP_PORT || '587',
  smtp_user: env.MAILGUN_SMTP_USER,
  smtp_pass: env.MAILGUN_SMTP_PASS,
  smtp_admin_email: env.MAILGUN_SENDER_EMAIL,
  smtp_sender_name: env.MAILGUN_SENDER_NAME,
  smtp_max_frequency: 60,

  mailer_subjects_magic_link: 'Sign in to Xana Asset System',
  mailer_templates_magic_link_content: magicLinkHtml,

  mailer_subjects_invite: "You're invited to Xana Asset System",
  mailer_templates_invite_content: inviteHtml,
};

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const responseText = await res.text();
console.log('HTTP', res.status);
console.log(responseText.slice(0, 2000));
if (!res.ok) process.exit(1);

console.log('\nSMTP + magic-link + invite templates pushed. Verify with: node scripts/check-auth-config.mjs');
console.log('Then send yourself a test magic link from /login, and a test invite from /admin, and confirm both arrive via Mailgun (From: ' + env.MAILGUN_SENDER_NAME + ' <' + env.MAILGUN_SENDER_EMAIL + '>).');
