<?php
// Copy to config.php and fill in real values. config.php is git-ignored and
// must live OUTSIDE public_html on cPanel.

return [
    // HMAC secret between the Node backend and this API (32+ random chars).
    'api_key' => 'CHANGE_ME_32_RANDOM_CHARS_MIN',

    // HTTPS is mandatory in production. Only trust forwarded protocol headers
    // from explicitly listed reverse-proxy IPs; leave empty for direct cPanel. TLS.
    'require_https' => true,
    'trusted_proxies' => [],
    'enable_render_endpoint' => false,

    // Sender mailbox (create in cPanel → Email Accounts).
    'from'     => ['address' => 'no-reply@yourdomain.com', 'name' => 'Verix'],
    'reply_to' => ['address' => 'support@yourdomain.com', 'name' => 'Verix Support'],

    // Absolute dashboard origin for links (no trailing slash, https).
    'dashboard_url' => 'https://app.yourdomain.com',

    // SMTP transport. cPanel mailbox: host mail.yourdomain.com port 587 tls.
    // Namecheap Private Email: host mail.privateemail.com port 587 tls.
    'smtp' => [
        'host'     => 'mail.yourdomain.com',
        'port'     => 587,                 // 587 = STARTTLS, 465 = SSL
        'secure'   => 'tls',               // 'tls' (587) | 'ssl' (465); plaintext is rejected
        'username' => 'no-reply@yourdomain.com',
        'password' => 'CHANGE_ME',
        'timeout'  => 15,
    ],

    // Branding (neutral, fixed — no tenant-supplied HTML).
    'brand' => [
        'product' => 'Verix',
        'legal'   => 'Verix Ltd',
        'address' => 'Registered office address',
        'support' => 'https://yourdomain.com/support',
    ],

    // Simple per-API-caller rate limit (flat file, no DB needed).
    'rate_limit' => ['max' => 300, 'windowSeconds' => 3600, 'file' => __DIR__ . '/.security-state'],

    // 'production' fails closed on placeholder config; 'development' is verbose.
    'env' => 'production',
];
