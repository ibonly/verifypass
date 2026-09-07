<?php
declare(strict_types=1);

// GET /health.php — configuration readiness. No secrets, no send.

require dirname(__DIR__) . '/src/bootstrap.php';

\VpMail\RequestGuard::securityHeaders();

$configPath = dirname(__DIR__) . '/config.php';
try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        throw new \VpMail\HttpException(405, 'Method not allowed', ['Allow' => 'GET']);
    }
    if (!is_file($configPath)) throw new RuntimeException('Mail API configuration is missing');
    $config = require $configPath;
    if (!is_array($config)) throw new RuntimeException('Mail API configuration is invalid');
    \VpMail\RequestGuard::requireConfig($config);
    \VpMail\RequestGuard::requireHttps($config, $_SERVER);
} catch (Throwable $error) {
    if ($error instanceof \VpMail\HttpException) {
        foreach ($error->headers as $name => $value) header("{$name}: {$value}");
        http_response_code($error->status);
        echo json_encode(['success' => false, 'error' => $error->getMessage()]);
    } else {
        error_log('mail-api health failed: ' . get_class($error));
        http_response_code(503);
        echo json_encode(['success' => false, 'error' => 'Service unavailable']);
    }
    exit;
}
echo json_encode([
    'success' => true,
    'service' => 'mail-api',
]);
