#!/usr/bin/env bash
set -euo pipefail
action="${1:?action required}"
folder="${2:?release root required}"
release="${3:?release identifier required}"
[[ "$folder" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 2
root="$HOME/$folder"
target="$root/releases/$release"
archive="$root/incoming/$release.tar.gz"

case "$action" in
  prepare)
    umask 022
    mkdir -p "$root/incoming" "$root/releases" "$root/shared"
    [[ ! -e "$target" && ! -L "$target" ]] || exit 3
    [[ ! -e "$root/current" || -L "$root/current" ]] || exit 3
    ;;
  stage)
    [[ -f "$archive" && ! -e "$target" ]] || exit 3
    [[ -f "$root/shared/email-config.php" ]] || { echo 'Missing private shared/email-config.php' >&2; exit 3; }
    php -r 'if ((fileperms($argv[1]) & 0077) !== 0) exit(1);' "$root/shared/email-config.php"
    mkdir "$target"
    tar -xzf "$archive" -C "$target"
    [[ -f "$target/dashboard/index.html" && -f "$target/verify/index.html" && -f "$target/mailer/public/send.php" ]] || exit 3
    [[ ! -e "$target/mailer/config.php" && ! -L "$target/mailer/config.php" ]] || exit 3
    ln -s "$root/shared/email-config.php" "$target/mailer/config.php"
    while IFS= read -r -d '' file; do php -l "$file" >/dev/null; done < <(find "$target/mailer" -type f -name '*.php' -print0)
    php -r 'require $argv[1]."/src/bootstrap.php"; $config = \VpMail\RequestGuard::requireConfig(require $argv[1]."/config.php"); if (($config["env"] ?? "") !== "production" || ($config["require_https"] ?? true) !== true || ($config["enable_render_endpoint"] ?? false) !== false) exit(1); $state = $config["rate_limit"]["file"] ?? ""; if (dirname($state) !== $argv[2] || !is_writable($argv[2])) exit(1);' "$target/mailer" "$root/shared"
    ;;
  promote)
    [[ -f "$target/manifest.json" ]] || exit 3
    previous="$(readlink "$root/current" || true)"
    [[ -z "$previous" || "$previous" =~ ^releases/[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 3
    printf '%s' "$previous" > "$root/incoming/$release.previous"
    ln -s "releases/$release" "$root/.current-$release"
    php -r 'if (!rename($argv[1], $argv[2])) exit(1);' "$root/.current-$release" "$root/current"
    ;;
  rollback)
    [[ "$(readlink "$root/current" || true)" == "releases/$release" ]] || exit 3
    previous="$(cat "$root/incoming/$release.previous")"
    if [[ -n "$previous" ]]; then
      [[ "$previous" =~ ^releases/[a-f0-9]{40}-[0-9]+-[0-9]+$ && -d "$root/$previous" ]] || exit 3
      ln -s "$previous" "$root/.rollback-$release"
      php -r 'if (!rename($argv[1], $argv[2])) exit(1);' "$root/.rollback-$release" "$root/current"
    else
      rm "$root/current"
    fi
    ;;
  *) exit 2 ;;
esac