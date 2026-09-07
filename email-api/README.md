# VerifyPass Mail API (PHP + SMTP, cPanel)

A single-purpose PHP mail API: the Node backend POSTs a message, this service
submits it over **SMTP**. SMTP acceptance does not guarantee inbox placement.
No Composer dependencies; requires PHP 8.1+ with OpenSSL and mbstring, a trusted
CA bundle, and mailbox SMTP credentials. Use a supported PHP release on cPanel.

```
email-api/
  config.example.php   copy to config.php (git-ignored, outside public_html)
  src/
    SmtpClient.php     minimal RFC 5321 client: AUTH LOGIN, STARTTLS/SSL
    Mailer.php         RFC 5322 builder: HTML + plain text, escaping, headers
    Templates.php      the email catalogue (all required messages)
    Renderer.php       brand layout + {var} substitution (escaped)
    RequestGuard.php   request authentication, validation, replay and rate limits
    HttpException.php  HTTP status and response headers
    bootstrap.php      autoloader
  public/
    send.php           authenticated POST JSON {to, template, vars} → send now
    render.php         POST → returns rendered subject/html/text without sending (preview/test)
    health.php         configuration readiness probe (no SMTP connection)
    .htaccess          hardening
  test/self-test.php   offline render/escaping checks (php test/self-test.php)
  test/security-test.php  offline request and SMTP regression checks
```

## Quick start (cPanel)

1. Upload `email-api/` **outside** `public_html`; point a subdomain (e.g.
   `mailer.yourdomain.com`) at `email-api/public/`.
2. `cp config.example.php config.php`, fill in DB-less settings: mailbox SMTP
    credentials (cPanel → Email Accounts), `api_key`, `dashboard_url`, then run
    `chmod 600 config.php`. Generate the key with `openssl rand -hex 32` and set
    that same value as `EMAIL_API_KEY` on the Node backend.
3. Verify SPF/DKIM/DMARC in cPanel → *Email Deliverability* (this is what makes
    authenticated delivery possible; inbox placement still depends on recipient
    filtering and sender reputation).
4. Keep `enable_render_endpoint` false. If TLS terminates at a proxy, add only
    that proxy's IP to `trusted_proxies`; never trust forwarded headers globally.
  5. From the repository root run `npm run test:email`, then check `GET /health.php`
    over HTTPS. A healthy response contains only `success` and `service`; it does
    not test SMTP login or security-state writability.

## API

`POST /send.php` uses body-bound HMAC authentication. The Node client sends:

- `X-Email-Timestamp`: Unix seconds, accepted within five minutes.
- `X-Email-Nonce`: a unique 16-byte hex nonce.
- `X-Email-Signature`: hex HMAC-SHA256 of
  `v1\n<timestamp>\n<nonce>\n<raw-json-body>` using `EMAIL_API_KEY`.

```json
{
  "to": "user@example.com",
  "template": "password_reset",
  "vars": { "requestedAt": "2026-09-07 12:00", "ip": "197.210.x.x", "actionUrl": "https://app.example.com/reset#token=..." }
}
```

Response: `{ "success": true }` or `{ "success": false, "error": "..." }`.
Send responses also include a `requestId`. The Node caller requires an explicit
`success: true` acknowledgement and rejects redirects. A timeout leaves delivery
uncertain; do not automatically retry, because nonce protection is not business
event deduplication and the SMTP server may already have accepted the message.

Token/link generation stays with the Node backend (it owns users and sessions);
this API only renders and delivers. Signed requests are replay-protected and
rate-limited in an atomically locked, mode-0600 state file.
This storage is intended for one PHP host with local filesystem locking. Multiple
hosts need shared, atomic replay and rate-limit storage before scaling out.

## Production operations

- Point the subdomain document root at `email-api/public/`; verify that
  `/config.php`, `/src/`, dotfiles, and directory indexes are unreachable.
- Use SMTP TLS on 587 or implicit TLS on 465. Plaintext SMTP is rejected and
  certificate/hostname verification is mandatory.
- Restrict `config.php` to the PHP account (`0600`) and keep it outside the web
  root. Keep PHP `display_errors=Off` and route `error_log` to a protected file.
- Monitor non-2xx rates and `mail-api request <id> failed` logs. Alert on 401,
  409, 429, and 503 spikes without logging request bodies, tokens, or addresses.
- Rotate the HMAC key by updating PHP and Node during one maintenance window;
  verify health and one synthetic mailbox delivery, then revoke the old value.
- Back up the previous application directory and config separately. Roll back
  code without restoring `.security-state`; retaining it preserves replay data.
- Before launch, confirm SPF authorizes the SMTP sender, DKIM passes, DMARC is
  published, PTR/HELO are provider-managed, and From aligns with the domain.
