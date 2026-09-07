<?php
declare(strict_types=1);

// POST /send.php  (X-Email-Key) — render a catalogue email and deliver it via
// SMTP immediately. Called server-to-server by the Node backend.

require dirname(__DIR__) . '/src/bootstrap.php';

use VpMail\{HttpException, Mailer, Renderer, RequestGuard, Templates};

RequestGuard::securityHeaders();
$requestId = bin2hex(random_bytes(8));

function out(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $configPath = dirname(__DIR__) . '/config.php';
    if (!is_file($configPath)) throw new \RuntimeException('Mail API configuration is missing');
    $config = require $configPath;
    if (!is_array($config)) throw new \RuntimeException('Mail API configuration is invalid');
    $config = RequestGuard::requireConfig($config);
    RequestGuard::requireHttps($config, $_SERVER);
    RequestGuard::requirePostJson($_SERVER);
    $raw = RequestGuard::readBody();
    RequestGuard::authenticate($config, $_SERVER, $raw);
    $body = RequestGuard::decodeObject($raw);
    if (array_diff(array_keys($body), ['to', 'template', 'vars'])) throw new HttpException(400, 'Unexpected request fields');

    $to = trim((string) ($body['to'] ?? ''));
    $template = (string) ($body['template'] ?? '');
    $vars = RequestGuard::validateVars($body['vars'] ?? null);
    if (!filter_var($to, FILTER_VALIDATE_EMAIL) || strlen($to) > 254 || preg_match('/[\r\n<>]/', $to)) {
        throw new HttpException(400, 'Invalid recipient address');
    }
    $spec = Templates::get($template);
    foreach ($spec['required'] as $name) {
        if (!isset($vars[$name]) || $vars[$name] === '') throw new HttpException(400, 'Missing required template variable');
    }
    $rendered = (new Renderer($config))->render($template, $vars);
    (new Mailer($config))->send($to, $rendered['subject'], $rendered['html'], $rendered['text'], $rendered['headers']);
    out(['success' => true, 'requestId' => $requestId]);
} catch (HttpException $e) {
    foreach ($e->headers as $name => $value) header("{$name}: {$value}");
    out(['success' => false, 'error' => $e->getMessage(), 'requestId' => $requestId], $e->status);
} catch (\InvalidArgumentException $e) {
    out(['success' => false, 'error' => 'Invalid request', 'requestId' => $requestId], 400);
} catch (\Throwable $e) {
    error_log("mail-api request {$requestId} failed: " . get_class($e) . ': ' . $e->getMessage());
    out(['success' => false, 'error' => 'Service unavailable', 'requestId' => $requestId], 503);
}
