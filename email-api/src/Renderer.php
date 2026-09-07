<?php
declare(strict_types=1);

namespace VpMail;

/**
 * Shared brand layout + {var} substitution. HTML variables are escaped; the
 * plain-text part is generated from the same data (never from the HTML).
 */
final class Renderer
{
    public function __construct(private array $config) {}

    /**
     * @param array<string,string> $vars
     * @return array{subject:string, html:string, text:string, headers:array<string,string>}
     */
    public function render(string $templateId, array $vars): array
    {
        $t = Templates::get($templateId);
        $brand = $this->config['brand'];
        $dash = rtrim((string) $this->config['dashboard_url'], '/');
        $vars += [
            'dashboardUrl' => $dash,
            'securityUrl'  => $dash . '/#settings-security',
            'settingsUrl'  => $dash . '/#settings',
            'webhooksUrl'  => $dash . '/#webhooks',
            'reviewUrl'    => $dash . '/#review',
            'reportsUrl'   => $dash . '/#reports',
            'adminUrl'     => $dash . '/#admin',
            'supportUrl'   => (string) $brand['support'],
        ];

        $subject = $this->sub($t['subject'], $vars, false);
        $preheader = $this->sub($t['preheader'], $vars, false);
        $paragraphs = array_map(fn($p) => $this->sub($p, $vars, true), $t['paragraphs']);

        $facts = [];
        foreach ($t['facts'] as [$label, $var]) {
            if (isset($vars[$var]) && $vars[$var] !== '') $facts[] = [$label, (string) $vars[$var]];
        }

        $cta = null;
        if (isset($t['cta'])) {
            $url = $vars[$t['cta']['var']] ?? null;
            if (!is_string($url) || !$this->trustedUrl($url)) {
                throw new \RuntimeException("{$templateId}: CTA URL is not trusted");
            }
            $cta = ['label' => $t['cta']['label'], 'url' => $url];
        }

        $unsub = !empty($t['unsubscribe']);
        return [
            'subject' => $subject,
            'html'    => $this->html($subject, $preheader, $paragraphs, $facts, $cta, $unsub),
            'text'    => $this->text($subject, $paragraphs, $facts, $cta, $unsub),
            'headers' => $unsub ? ['List-Unsubscribe' => '<' . $dash . '/#settings-notifications>'] : [],
        ];
    }

    private function sub(string $template, array $vars, bool $html): string
    {
        return (string) preg_replace_callback('/\{(\w+)\}/', function ($m) use ($vars, $html) {
            $v = mb_substr((string) ($vars[$m[1]] ?? ''), 0, 300);
            return $html ? htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') : $v;
        }, $template);
    }

    private function html(string $subject, string $preheader, array $paragraphs, array $facts, ?array $cta, bool $unsub): string
    {
        $brand = $this->config['brand'];
        $e = fn(string $s) => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

        $factRows = '';
        foreach ($facts as [$label, $value]) {
            $factRows .= '<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;border-bottom:1px solid #f3f4f6">'
                . $e($label) . '</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #f3f4f6;word-break:break-word">'
                . $e($value) . '</td></tr>';
        }
        $paras = '';
        foreach ($paragraphs as $p) $paras .= '<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#374151">' . $p . '</p>';
        $ctaHtml = $cta
            ? '<p style="margin:22px 0"><a href="' . $e($cta['url']) . '" style="background:#6d28d9;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;display:inline-block">' . $e($cta['label']) . '</a></p>'
            : '';
        $unsubHtml = $unsub
            ? ' · <a href="' . $e(rtrim((string) $this->config['dashboard_url'], '/') . '/#settings-notifications') . '" style="color:#9ca3af">Unsubscribe from digests</a>'
            : '';

        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<title>' . $e($subject) . '</title></head>'
            . '<body style="margin:0;padding:0;background:#f9fafb;font-family:system-ui,-apple-system,Segoe UI,sans-serif">'
            . '<span style="display:none;max-height:0;overflow:hidden">' . $e($preheader) . '</span>'
            . '<div style="max-width:560px;margin:0 auto;padding:24px 16px">'
            . '<div style="padding:16px 24px;background:#111827;border-radius:10px 10px 0 0"><span style="color:#ffffff;font-size:16px;font-weight:700">' . $e($brand['product']) . '</span></div>'
            . '<div style="background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px">'
            . $paras
            . ($factRows ? '<table role="presentation" style="width:100%;border-collapse:collapse;margin:6px 0 16px">' . $factRows . '</table>' : '')
            . $ctaHtml
            . '</div>'
            . '<p style="font-size:11px;color:#9ca3af;padding:14px 8px 0;line-height:1.5">'
            . $e($brand['legal']) . ' · ' . $e($brand['address']) . $unsubHtml
            . '</p></div></body></html>';
    }

    private function text(string $subject, array $paragraphs, array $facts, ?array $cta, bool $unsub): string
    {
        $brand = $this->config['brand'];
        $strip = fn(string $s) => trim(html_entity_decode(strip_tags($s), ENT_QUOTES, 'UTF-8'));
        $lines = [$subject, str_repeat('=', min(strlen($subject), 60)), ''];
        foreach ($paragraphs as $p) { $lines[] = $strip($p); $lines[] = ''; }
        foreach ($facts as [$label, $value]) $lines[] = $label . ': ' . $value;
        if ($facts) $lines[] = '';
        if ($cta) { $lines[] = $cta['label'] . ': ' . $cta['url']; $lines[] = ''; }
        $lines[] = '—';
        $lines[] = $brand['legal'] . ' · ' . $brand['address'];
        if ($unsub) $lines[] = 'Unsubscribe from digests: ' . rtrim((string) $this->config['dashboard_url'], '/') . '/#settings-notifications';
        return implode("\n", $lines);
    }

    private function trustedUrl(string $url): bool
    {
        $candidate = parse_url($url);
        if (!is_array($candidate) || strtolower((string) ($candidate['scheme'] ?? '')) !== 'https'
            || !isset($candidate['host']) || isset($candidate['user']) || isset($candidate['pass'])) return false;
        foreach ([$this->config['dashboard_url'] ?? '', $this->config['brand']['support'] ?? ''] as $trustedUrl) {
            $trusted = parse_url((string) $trustedUrl);
            if (is_array($trusted)
                && strtolower((string) ($trusted['scheme'] ?? '')) === 'https'
                && strtolower((string) ($candidate['host'] ?? '')) === strtolower((string) ($trusted['host'] ?? ''))
                && (int) ($candidate['port'] ?? 443) === (int) ($trusted['port'] ?? 443)) return true;
        }
        return false;
    }
}
