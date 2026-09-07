<?php
declare(strict_types=1);

namespace VpMail;

/**
 * RFC 5322 message builder + SMTP delivery. Always multipart/alternative
 * (HTML + plain text). Returns nothing on success, throws RuntimeException.
 */
final class Mailer
{
    public function __construct(private array $config) {}

    /** @param array<string,string> $extraHeaders */
    public function send(string $to, string $subject, string $html, string $text, array $extraHeaders = []): void
    {
        if (!$this->validAddress($to)) {
            throw new \InvalidArgumentException('Invalid recipient address');
        }
        $from = $this->config['from'];
        $replyTo = $this->config['reply_to'];
        if (!$this->validAddress((string) ($from['address'] ?? '')) || !$this->validAddress((string) ($replyTo['address'] ?? ''))
            || preg_match('/[\r\n]/', (string) ($from['name'] ?? '')) || preg_match('/[\r\n]/', (string) ($replyTo['name'] ?? ''))) {
            throw new \InvalidArgumentException('Invalid sender configuration');
        }
        $boundary = '=_vp_' . bin2hex(random_bytes(12));
        $domain = substr(strrchr($from['address'], '@') ?: '@localhost', 1);

        $headers = [
            'From'         => $this->addr($from['name'], $from['address']),
            'Reply-To'     => $this->addr($replyTo['name'], $replyTo['address']),
            'To'           => $to,
            'Subject'      => $this->enc($subject),
            'MIME-Version' => '1.0',
            'Content-Type' => 'multipart/alternative; boundary="' . $boundary . '"',
            'Message-ID'   => sprintf('<%s@%s>', bin2hex(random_bytes(12)), $domain),
            'Date'         => gmdate('r'),
            'X-Mailer'     => 'VerifyPass-Mail/1.0',
        ];
        foreach ($extraHeaders as $name => $value) {
            if ($name !== 'List-Unsubscribe' || preg_match('/[\r\n]/', $value)) {
                throw new \InvalidArgumentException('Invalid message header');
            }
            $headers[$name] = $value;
        }

        $head = '';
        foreach ($headers as $k => $v) $head .= $k . ': ' . $v . "\r\n";

        $body = "--{$boundary}\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
            . quoted_printable_encode($text) . "\r\n"
            . "--{$boundary}\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
            . quoted_printable_encode($html) . "\r\n"
            . "--{$boundary}--\r\n";

        $smtpCfg = $this->config['smtp'];
        $smtp = new SmtpClient(
            (string) $smtpCfg['host'], (int) $smtpCfg['port'], (string) $smtpCfg['secure'],
            (string) $smtpCfg['username'], (string) $smtpCfg['password'], (int) ($smtpCfg['timeout'] ?? 15)
        );
        try {
            $smtp->send($from['address'], [$to], $head . "\r\n" . $body);
        } finally {
            $smtp->quit();
        }
    }

    private function enc(string $value): string
    {
        return '=?UTF-8?B?' . base64_encode(mb_substr($value, 0, 150)) . '?=';
    }

    private function addr(string $name, string $address): string
    {
        return $this->enc($name) . ' <' . $address . '>';
    }

    private function validAddress(string $address): bool
    {
        return strlen($address) <= 254
            && !preg_match('/[\r\n<>]/', $address)
            && filter_var($address, FILTER_VALIDATE_EMAIL) !== false;
    }
}
