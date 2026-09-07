<?php
declare(strict_types=1);

// POST /render.php (X-Email-Key) — render a template WITHOUT sending.
// Used for previews and integration tests.

require dirname(__DIR__) . '/src/bootstrap.php';

use VpMail\{HttpException, Renderer, RequestGuard, Templates};

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
    if (($config['enable_render_endpoint'] ?? false) !== true) throw new HttpException(404, 'Not found');
    RequestGuard::requireHttps($config, $_SERVER);
    RequestGuard::requirePostJson($_SERVER);
    $raw = RequestGuard::readBody();
    RequestGuard::authenticate($config, $_SERVER, $raw);
    $body = RequestGuard::decodeObject($raw);
    if (array_diff(array_keys($body), ['template', 'vars'])) throw new HttpException(400, 'Unexpected request fields');
    $template = (string) ($body['template'] ?? '');
    $vars = RequestGuard::validateVars($body['vars'] ?? null);
    $spec = Templates::get($template);
    foreach ($spec['required'] as $name) {
        if (!isset($vars[$name]) || $vars[$name] === '') throw new HttpException(400, 'Missing required template variable');
    }
    $rendered = (new Renderer($config))->render($template, $vars);
    out(['success' => true, 'requestId' => $requestId] + $rendered);
} catch (HttpException $e) {
    foreach ($e->headers as $name => $value) header("{$name}: {$value}");
    out(['success' => false, 'error' => $e->getMessage(), 'requestId' => $requestId], $e->status);
} catch (\InvalidArgumentException $e) {
    out(['success' => false, 'error' => 'Invalid request', 'requestId' => $requestId], 400);
} catch (\Throwable $e) {
    error_log("mail-api render {$requestId} failed: " . get_class($e) . ': ' . $e->getMessage());
    out(['success' => false, 'error' => 'Service unavailable', 'requestId' => $requestId], 503);
}
