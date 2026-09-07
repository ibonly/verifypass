<?php
declare(strict_types=1);

namespace VpMail;

final class RequestGuard
{
    public const MAX_BODY_BYTES = 65536;
    private const CLOCK_SKEW_SECONDS = 300;

    /** @return array<string,mixed> */
    public static function requireConfig(array $config): array
    {
        $production = ($config['env'] ?? '') === 'production';
        $key = (string) ($config['api_key'] ?? '');
        $smtp = is_array($config['smtp'] ?? null) ? $config['smtp'] : [];
        $from = is_array($config['from'] ?? null) ? $config['from'] : [];
        $replyTo = is_array($config['reply_to'] ?? null) ? $config['reply_to'] : [];
        $problems = [];

        if (strlen($key) < 32 || str_contains($key, 'CHANGE_ME')) $problems[] = 'api_key';
        if (!in_array($smtp['secure'] ?? null, ['tls', 'ssl'], true)) $problems[] = 'smtp.secure';
        if (empty($smtp['host']) || preg_match('/[\r\n]/', (string) ($smtp['host'] ?? ''))) $problems[] = 'smtp.host';
        if (empty($smtp['username']) || empty($smtp['password']) || str_contains((string) ($smtp['password'] ?? ''), 'CHANGE_ME')) $problems[] = 'smtp.credentials';
        foreach (['from' => $from, 'reply_to' => $replyTo] as $name => $address) {
            if (!filter_var($address['address'] ?? '', FILTER_VALIDATE_EMAIL)) $problems[] = $name;
            if (preg_match('/[\r\n]/', (string) ($address['name'] ?? ''))) $problems[] = $name . '.name';
        }
        foreach (['dashboard_url' => $config['dashboard_url'] ?? '', 'brand.support' => $config['brand']['support'] ?? ''] as $name => $url) {
            if (!self::validHttpsUrl((string) $url)) $problems[] = $name;
        }
        $rate = is_array($config['rate_limit'] ?? null) ? $config['rate_limit'] : [];
        if ((int) ($rate['max'] ?? 0) < 1 || (int) ($rate['max'] ?? 0) > 10000) $problems[] = 'rate_limit.max';
        if ((int) ($rate['windowSeconds'] ?? 0) < 60 || (int) ($rate['windowSeconds'] ?? 0) > 86400) $problems[] = 'rate_limit.windowSeconds';

        $configPath = dirname(__DIR__) . '/config.php';
        if ($production && is_file($configPath)) {
            $permissions = fileperms($configPath);
            if ($permissions !== false && ($permissions & 0077) !== 0) $problems[] = 'config.php permissions';
        }
        if ($problems) throw new \RuntimeException('Invalid mail API configuration: ' . implode(', ', array_unique($problems)));
        return $config;
    }

    public static function securityHeaders(): void
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: no-referrer');
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
    }

    public static function requirePostJson(array $server): void
    {
        if (($server['REQUEST_METHOD'] ?? '') !== 'POST') {
            throw new HttpException(405, 'Method not allowed', ['Allow' => 'POST']);
        }
        $contentType = strtolower(trim(explode(';', (string) ($server['CONTENT_TYPE'] ?? ''))[0]));
        if ($contentType !== 'application/json') throw new HttpException(415, 'Unsupported media type');
        $length = filter_var($server['CONTENT_LENGTH'] ?? null, FILTER_VALIDATE_INT);
        if ($length !== false && $length > self::MAX_BODY_BYTES) throw new HttpException(413, 'Request too large');
    }

    public static function requireHttps(array $config, array $server): void
    {
        if (($config['env'] ?? '') !== 'production' || ($config['require_https'] ?? true) === false) return;
        $https = strtolower((string) ($server['HTTPS'] ?? ''));
        $secure = $https === 'on' || $https === '1' || (int) ($server['SERVER_PORT'] ?? 0) === 443;
        $remote = (string) ($server['REMOTE_ADDR'] ?? '');
        $trusted = array_map('strval', is_array($config['trusted_proxies'] ?? null) ? $config['trusted_proxies'] : []);
        if (!$secure && in_array($remote, $trusted, true)) {
            $forwarded = strtolower(trim(explode(',', (string) ($server['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
            $secure = $forwarded === 'https';
        }
        if (!$secure) throw new HttpException(400, 'HTTPS required');
    }

    public static function readBody(): string
    {
        $stream = fopen('php://input', 'rb');
        if ($stream === false) throw new HttpException(400, 'Invalid request body');
        $body = stream_get_contents($stream, self::MAX_BODY_BYTES + 1);
        fclose($stream);
        if ($body === false || strlen($body) > self::MAX_BODY_BYTES) throw new HttpException(413, 'Request too large');
        return $body;
    }

    /** @return array<string,mixed> */
    public static function decodeObject(string $body): array
    {
        try {
            $decoded = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpException(400, 'Invalid JSON body');
        }
        if (!is_array($decoded) || array_is_list($decoded)) throw new HttpException(400, 'JSON body must be an object');
        return $decoded;
    }

    public static function authenticate(array $config, array $server, string $body): void
    {
        $timestamp = (string) ($server['HTTP_X_EMAIL_TIMESTAMP'] ?? '');
        $nonce = strtolower((string) ($server['HTTP_X_EMAIL_NONCE'] ?? ''));
        $signature = strtolower((string) ($server['HTTP_X_EMAIL_SIGNATURE'] ?? ''));
        if (!preg_match('/^\d{10}$/', $timestamp) || abs(time() - (int) $timestamp) > self::CLOCK_SKEW_SECONDS
            || !preg_match('/^[a-f0-9]{32,64}$/', $nonce) || !preg_match('/^[a-f0-9]{64}$/', $signature)) {
            throw new HttpException(401, 'Unauthorized');
        }
        $expected = hash_hmac('sha256', "v1\n{$timestamp}\n{$nonce}\n{$body}", (string) $config['api_key']);
        if (!hash_equals($expected, $signature)) throw new HttpException(401, 'Unauthorized');

        self::consumeNonceAndRateLimit($config, $nonce, (int) $timestamp);
    }

    /** @return array<string,string> */
    public static function validateVars(mixed $vars): array
    {
        if (!is_array($vars) || array_is_list($vars) || count($vars) > 32) throw new HttpException(400, 'Invalid template variables');
        $clean = [];
        foreach ($vars as $name => $value) {
            if (!is_string($name) || !preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $name) || !is_scalar($value)) {
                throw new HttpException(400, 'Invalid template variables');
            }
            $string = (string) $value;
            if (strlen($string) > 2048 || str_contains($string, "\0")) throw new HttpException(400, 'Invalid template variables');
            $clean[$name] = $string;
        }
        return $clean;
    }

    private static function consumeNonceAndRateLimit(array $config, string $nonce, int $timestamp): void
    {
        $rate = is_array($config['rate_limit'] ?? null) ? $config['rate_limit'] : [];
        $file = (string) ($rate['file'] ?? dirname(__DIR__) . '/.security-state');
        $max = max(1, (int) ($rate['max'] ?? 300));
        $window = max(60, min(86400, (int) ($rate['windowSeconds'] ?? 3600)));
        $handle = @fopen($file, 'c+');
        if ($handle === false || !flock($handle, LOCK_EX)) throw new \RuntimeException('Security state unavailable');
        try {
            if (!@chmod($file, 0600) && ($config['env'] ?? '') === 'production') {
                throw new \RuntimeException('Security state permissions could not be restricted');
            }
            $contents = stream_get_contents($handle);
            $state = json_decode($contents ?: '{}', true);
            if (!is_array($state)) throw new \RuntimeException('Security state is corrupt');
            $now = time();
            $nonces = is_array($state['nonces'] ?? null) ? $state['nonces'] : [];
            $nonces = array_filter($nonces, fn($seen) => is_int($seen) && $seen >= $now - self::CLOCK_SKEW_SECONDS);
            if (isset($nonces[$nonce])) throw new HttpException(409, 'Request already processed');
            $nonces[$nonce] = $timestamp;

            $bucket = (string) intdiv($now, $window);
            $counts = is_array($state['counts'] ?? null) ? $state['counts'] : [];
            $count = (int) ($counts[$bucket] ?? 0) + 1;
            if ($count > $max) throw new HttpException(429, 'Rate limited');
            $state = ['nonces' => $nonces, 'counts' => [$bucket => $count]];
            rewind($handle);
            if (!ftruncate($handle, 0) || fwrite($handle, json_encode($state, JSON_THROW_ON_ERROR)) === false) {
                throw new \RuntimeException('Security state write failed');
            }
            fflush($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    private static function validHttpsUrl(string $url): bool
    {
        $parts = parse_url($url);
        return is_array($parts) && strtolower((string) ($parts['scheme'] ?? '')) === 'https'
            && isset($parts['host']) && filter_var($url, FILTER_VALIDATE_URL) !== false
            && !isset($parts['user']) && !isset($parts['pass']);
    }
}

final class HttpException extends \RuntimeException
{
    /** @param array<string,string> $headers */
    public function __construct(public readonly int $status, string $message, public readonly array $headers = [])
    {
        parent::__construct($message);
    }
}
