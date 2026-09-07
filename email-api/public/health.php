<?php
declare(strict_types=1);

// GET /health.php — liveness probe. No secrets, no send.

require dirname(__DIR__) . '/src/bootstrap.php';

\VpMail\RequestGuard::securityHeaders();

$configPath = dirname(__DIR__) . '/config.php';
try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        header('Allow: GET');
        throw new \VpMail\HttpException(405, 'Method not allowed');
    }
    if (!is_file($configPath)) throw new RuntimeException('Mail API configuration is missing');
    $config = require $configPath;
    if (!is_array($config)) throw new RuntimeException('Mail API configuration is invalid');
    \VpMail\RequestGuard::requireConfig($config);
} catch (Throwable $error) {
    error_log('mail-api health failed: ' . get_class($error) . ': ' . $error->getMessage());
    $status = $error instanceof \VpMail\HttpException ? $error->status : 503;
    http_response_code($status);
    echo json_encode(['success' => false, 'error' => $status === 405 ? 'Method not allowed' : 'Service unavailable']);
    exit;
}
if (($config['env'] ?? '') === 'production') {
    try {
        \VpMail\RequestGuard::requireHttps($config, $_SERVER);
    } catch (Throwable) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'HTTPS required']);
        exit;
    }
}
if (!isset($config['smtp'])) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Service unavailable']);
    exit;
}
echo json_encode([
    'success' => true,
    'service' => 'mail-api',
]);
