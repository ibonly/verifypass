<?php
declare(strict_types=1);

// Offline self-test: template catalogue integrity, escaping, CTA URLs.
// No SMTP or network needed. Run: php test/self-test.php

require dirname(__DIR__) . '/src/bootstrap.php';

use VpMail\{Renderer, Templates};

$config = require dirname(__DIR__) . '/config.example.php';
$config['dashboard_url'] = 'https://app.example.com';

$renderer = new Renderer($config);
$failures = 0;

foreach (Templates::CATALOG as $id => $spec) {
    $vars = [];
    foreach ($spec['required'] as $v) {
        $vars[$v] = str_ends_with($v, 'Url') ? 'https://app.example.com/x#token=abc' : '<b>' . $v . '</b>';
    }
    try {
        $out = $renderer->render($id, $vars);
        if ($out['subject'] === '' || strlen($out['html']) < 300 || strlen($out['text']) < 50) {
            throw new RuntimeException('rendered output too small');
        }
        if (str_contains($out['html'], '<b>')) throw new RuntimeException('unescaped variable in HTML');
        if (isset($spec['cta']) && !str_contains($out['html'], 'https://')) throw new RuntimeException('CTA URL missing');
        echo "ok   {$id}\n";
    } catch (Throwable $e) {
        $failures++;
        echo "FAIL {$id}: {$e->getMessage()}\n";
    }
}

echo $failures === 0
    ? "\nself-test: all " . count(Templates::CATALOG) . " templates passed\n"
    : "\nself-test: {$failures} FAILURES\n";
exit($failures === 0 ? 0 : 1);
