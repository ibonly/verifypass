<?php
declare(strict_types=1);

namespace VpMail;

/**
 * Minimal SMTP client (RFC 5321): EHLO, STARTTLS/SSL, AUTH LOGIN, DATA with
 * dot-stuffing. PHP streams with OpenSSL. Throws on any
 * unexpected response code.
 */
final class SmtpClient
{
    /** @var resource */
    private $sock;

    private bool $closed = false;

    public function __construct(string $host, int $port, string $secure, string $username, string $password, int $timeout = 15)
    {
        if (!in_array($secure, ['tls', 'ssl'], true)) {
            throw new \InvalidArgumentException('SMTP encryption must be tls or ssl');
        }
        if ($host === '' || preg_match('/[\r\n]/', $host) || $port < 1 || $port > 65535 || $timeout < 1 || $timeout > 60) {
            throw new \InvalidArgumentException('Invalid SMTP connection settings');
        }
        $remote = $secure === 'ssl' ? "ssl://{$host}" : $host;
        $errno = 0; $errstr = '';
        $context = stream_context_create(['ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'peer_name' => $host,
            'SNI_enabled' => true,
            'disable_compression' => true,
        ]]);
        $this->sock = @stream_socket_client(
            "{$remote}:{$port}", $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context
        );
        if (!$this->sock) throw new \RuntimeException("SMTP connect failed: {$errstr} ({$errno})");
        stream_set_timeout($this->sock, $timeout);

        $this->expect(220);
        $ehlo = preg_replace('/[^A-Za-z0-9.-]/', '', gethostname() ?: '') ?: 'localhost';
        $capabilities = $this->cmd("EHLO {$ehlo}", 250);

        if ($secure === 'tls') {
            if (!preg_match('/^250[ -]STARTTLS\s*$/mi', $capabilities)) {
                throw new \RuntimeException('SMTP server does not advertise STARTTLS');
            }
            $this->cmd('STARTTLS', 220);
            if (!stream_socket_enable_crypto($this->sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new \RuntimeException('SMTP STARTTLS negotiation failed');
            }
            $capabilities = $this->cmd("EHLO {$ehlo}", 250);
        }

        if (!preg_match('/^250[ -]AUTH(?:\s+|=.*\s*)[^\r\n]*\bLOGIN\b/im', $capabilities)) {
            throw new \RuntimeException('SMTP server does not advertise AUTH LOGIN');
        }

        $this->cmd('AUTH LOGIN', 334);
        $this->cmd(base64_encode($username), 334);
        $this->cmd(base64_encode($password), 235);
    }

    /** @param string[] $rcpts */
    public function send(string $from, array $rcpts, string $data): void
    {
        if (!$this->validAddress($from) || !$rcpts) {
            throw new \InvalidArgumentException('Invalid SMTP envelope');
        }
        $this->cmd("MAIL FROM:<{$from}>", 250);
        foreach ($rcpts as $rcpt) {
            if (!$this->validAddress($rcpt)) throw new \InvalidArgumentException('Invalid SMTP recipient');
            $this->cmd("RCPT TO:<{$rcpt}>", [250, 251]);
        }
        $this->cmd('DATA', 354);
        $data = str_replace(["\r\n", "\r"], "\n", $data);
        $data = preg_replace('/^\./m', '..', $data);
        $this->write(str_replace("\n", "\r\n", $data) . "\r\n.\r\n");
        $this->expect(250);
    }

    public function quit(): void
    {
        if ($this->closed) return;
        try { $this->cmd('QUIT', 221); } catch (\Throwable) { /* closing anyway */ }
        if (is_resource($this->sock)) fclose($this->sock);
        $this->closed = true;
    }

    public function __destruct()
    {
        if (isset($this->sock) && is_resource($this->sock) && !$this->closed) fclose($this->sock);
    }

    /** @param int|int[] $code */
    private function cmd(string $line, int|array $code): string
    {
        $this->write($line . "\r\n");
        return $this->expect($code);
    }

    private function write(string $bytes): void
    {
        $offset = 0;
        $length = strlen($bytes);
        while ($offset < $length) {
            $written = fwrite($this->sock, substr($bytes, $offset));
            if ($written === false || $written === 0) throw new \RuntimeException('SMTP write failed');
            $offset += $written;
        }
    }

    /** @param int|int[] $code */
    private function expect(int|array $code): string
    {
        $codes = (array) $code;
        $response = '';
        $responseCode = null;
        $complete = false;
        while (($line = fgets($this->sock, 513)) !== false) {
            if (!str_ends_with($line, "\r\n") || !preg_match('/^(\d{3})([ -])/', $line, $match)) {
                throw new \RuntimeException('Malformed SMTP response');
            }
            $lineCode = (int) $match[1];
            $responseCode ??= $lineCode;
            if ($lineCode !== $responseCode) throw new \RuntimeException('Inconsistent SMTP response');
            $response .= $line;
            if (strlen($response) > 16384) throw new \RuntimeException('SMTP response too large');
            if ($match[2] === ' ') {
                $complete = true;
                break;
            }
        }
        $meta = stream_get_meta_data($this->sock);
        if (($meta['timed_out'] ?? false) === true) throw new \RuntimeException('SMTP response timed out');
        if (!$complete) throw new \RuntimeException('SMTP connection closed unexpectedly');
        if (!in_array($responseCode, $codes, true)) {
            throw new \RuntimeException('SMTP error ' . $responseCode);
        }
        return $response;
    }

    private function validAddress(string $address): bool
    {
        return strlen($address) <= 254
            && !preg_match('/[\r\n<>]/', $address)
            && filter_var($address, FILTER_VALIDATE_EMAIL) !== false;
    }
}
