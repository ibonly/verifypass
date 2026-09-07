<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

use VpMail\{HttpException, Mailer, Renderer, RequestGuard, SmtpClient};

$config = require dirname(__DIR__) . '/config.example.php';
$config['env'] = 'development';
$config['api_key'] = str_repeat('a', 32);
$config['smtp']['password'] = 'not-a-placeholder';
$config['dashboard_url'] = 'https://app.example.com';
$config['brand']['support'] = 'https://www.example.com/support';
$config['rate_limit'] = [
    'max' => 2,
    'windowSeconds' => 3600,
    'file' => sys_get_temp_dir() . '/vp-mail-security-' . bin2hex(random_bytes(8)),
];

$failures = 0;
$run = function (string $name, callable $test) use (&$failures): void {
    try {
        $test();
        echo "ok   {$name}\n";
    } catch (Throwable $error) {
        $failures++;
        echo "FAIL {$name}: {$error->getMessage()}\n";
    }
};
$expectHttp = function (int $status, callable $test): void {
    try {
        $test();
    } catch (HttpException $error) {
        if ($error->status === $status) return;
        throw new RuntimeException("expected HTTP {$status}, got {$error->status}");
    }
    throw new RuntimeException("expected HTTP {$status}");
};
$headers = function (string $body, ?int $timestamp = null, ?string $nonce = null) use ($config): array {
    $timestamp = $timestamp ?? time();
    $nonce = $nonce ?? bin2hex(random_bytes(16));
    return [
        'HTTP_X_EMAIL_TIMESTAMP' => (string) $timestamp,
        'HTTP_X_EMAIL_NONCE' => $nonce,
        'HTTP_X_EMAIL_SIGNATURE' => hash_hmac('sha256', "v1\n{$timestamp}\n{$nonce}\n{$body}", $config['api_key']),
    ];
};

$run('HTTP exception autoloads independently of request guard', function (): void {
    $error = new HttpException(405, 'Method not allowed', ['Allow' => 'GET']);
    if ($error->status !== 405 || $error->headers !== ['Allow' => 'GET']) {
        throw new RuntimeException('HTTP exception contract changed');
    }
});

$run('valid HMAC is accepted once', function () use ($config, $headers): void {
    $body = '{"to":"user@example.com"}';
    RequestGuard::authenticate($config, $headers($body), $body);
});

$run('replayed nonce is rejected', function () use ($config, $headers, $expectHttp): void {
    $body = '{"template":"welcome"}';
    $server = $headers($body);
    RequestGuard::authenticate($config, $server, $body);
    $expectHttp(409, fn() => RequestGuard::authenticate($config, $server, $body));
});

$run('stale and tampered signatures are rejected', function () use ($config, $headers, $expectHttp): void {
    $body = '{}';
    $expectHttp(401, fn() => RequestGuard::authenticate($config, $headers($body, time() - 301), $body));
    $server = $headers($body);
    $expectHttp(401, fn() => RequestGuard::authenticate($config, $server, '{"changed":true}'));
});

$run('request shape and variable limits are enforced', function () use ($expectHttp): void {
    $expectHttp(415, fn() => RequestGuard::requirePostJson(['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'text/plain']));
    $expectHttp(413, fn() => RequestGuard::requirePostJson([
        'REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json',
        'CONTENT_LENGTH' => (string) (RequestGuard::MAX_BODY_BYTES + 1),
    ]));
    $expectHttp(400, fn() => RequestGuard::validateVars(['bad-key!' => 'value']));
    $expectHttp(400, fn() => RequestGuard::validateVars(['value' => str_repeat('x', 2049)]));
});

$run('renderer rejects untrusted CTA origins', function () use ($config): void {
    $renderer = new Renderer($config);
    try {
        $renderer->render('verify_email', ['companyName' => 'Acme', 'actionUrl' => 'https://evil.example/reset']);
    } catch (RuntimeException $error) {
        if (str_contains($error->getMessage(), 'not trusted')) return;
        throw $error;
    }
    throw new RuntimeException('untrusted URL was accepted');
});

$run('mailer rejects recipient and header injection before SMTP', function () use ($config): void {
    $mailer = new Mailer($config);
    foreach ([
        fn() => $mailer->send("user@example.com\r\nBcc:x@example.com", 'subject', 'html', 'text'),
        fn() => $mailer->send('user@example.com', 'subject', 'html', 'text', ['List-Unsubscribe' => "<https://example.com>\r\nBcc:x@example.com"]),
    ] as $attempt) {
        try {
            $attempt();
        } catch (InvalidArgumentException) {
            continue;
        }
        throw new RuntimeException('injection input was accepted');
    }
});

$run('SMTP accepts complete replies and rejects truncated or oversized replies', function (): void {
    $reflection = new ReflectionClass(SmtpClient::class);
    $expect = $reflection->getMethod('expect');
    foreach ([
        ["250 OK\r\n", true],
        ["250-STARTTLS\r\n250 AUTH LOGIN\r\n", true],
        ["250-STARTTLS\r\n", false],
        ["250 OK", false],
        ["250 OK\n", false],
        ["250-STARTTLS\r\n550 Rejected\r\n", false],
        ["250 " . str_repeat('x', 509) . "\r\n", false],
        [str_repeat("250-Capability\r\n", 1200) . "250 OK\r\n", false],
    ] as [$reply, $valid]) {
        $client = $reflection->newInstanceWithoutConstructor();
        $stream = fopen('php://temp', 'w+');
        fwrite($stream, $reply);
        rewind($stream);
        $reflection->getProperty('sock')->setValue($client, $stream);
        try {
            $accepted = true;
            try {
                $expect->invoke($client, 250);
            } catch (RuntimeException) {
                $accepted = false;
            }
            if ($accepted !== $valid) throw new RuntimeException('Unexpected SMTP reply acceptance');
        } finally {
            fclose($stream);
        }
    }
});

@unlink($config['rate_limit']['file']);
echo $failures === 0 ? "\nsecurity-test: passed\n" : "\nsecurity-test: {$failures} FAILURES\n";
exit($failures === 0 ? 0 : 1);
