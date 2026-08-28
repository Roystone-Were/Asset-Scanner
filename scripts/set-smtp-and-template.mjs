// Configures custom SMTP (Office 365) + the branded Magic Link and Invite
// email templates via the Supabase Management API. Same pattern as
// apply-migration.mjs / check-auth-config.mjs.
//
// Requires these in .env.local (in addition to the existing SUPABASE_* vars):
//   OFFICE365_SMTP_USER=noreply@xanalife.com   (the mailbox's own address — also the login)
//   OFFICE365_SMTP_PASS=<mailbox password, or an app password if MFA is on>
//   OFFICE365_SENDER_NAME=Xana Asset System
//
// IMPORTANT — this will fail with an auth error even with a correct password
// unless SMTP AUTH is explicitly enabled for THIS mailbox. Microsoft disables
// basic SMTP AUTH tenant-wide by default (since ~2022); the password alone
// isn't enough. Ask IT to run, for this mailbox specifically:
//   Set-CASMailbox -Identity noreply@xanalife.com -SmtpClientAuthenticationDisabled $false
// (Exchange admin center: that mailbox > Manage email apps > enable
// "Authenticated SMTP".) If it's tenant-wide disabled, check
// Set-TransportConfig -SmtpClientAuthenticationDisabled first too.
//
// Usage: node scripts/set-smtp-and-template.mjs
import fs from 'fs';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const projectRef = env.SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
const required = ['SUPABASE_ACCESS_TOKEN', 'OFFICE365_SMTP_USER', 'OFFICE365_SMTP_PASS', 'OFFICE365_SENDER_NAME'];
const missing = required.filter((k) => !env[k]).concat(projectRef ? [] : ['SUPABASE_URL (unparseable)']);
if (missing.length) {
  console.error('Missing in .env.local:', missing.join(', '));
  process.exit(1);
}

const magicLinkHtml = fs.readFileSync('scripts/email-templates/magic-link.html', 'utf8');
const inviteHtml = fs.readFileSync('scripts/email-templates/invite.html', 'utf8');

const body = {
  external_email_enabled: true,

  smtp_host: 'smtp.office365.com',
  smtp_port: '587',
  smtp_user: env.OFFICE365_SMTP_USER,
  smtp_pass: env.OFFICE365_SMTP_PASS,
  smtp_admin_email: env.OFFICE365_SMTP_USER, // Office 365 requires From == the authenticated mailbox
  smtp_sender_name: env.OFFICE365_SENDER_NAME,
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
console.log('Then send yourself a test magic link from /login, and a test invite from /admin, and confirm both arrive via Office 365 (From: ' + env.OFFICE365_SENDER_NAME + ' <' + env.OFFICE365_SMTP_USER + '>).');
console.log('If it fails with an auth error, the most likely cause is SMTP AUTH not being enabled for this mailbox — see the note at the top of this file.');
