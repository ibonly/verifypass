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
current="$root/current"
next="$root/.current-$release"
previous_backup="$root/.previous-$release"
previous_file="$root/incoming/$release.previous"

case "$action" in
  prepare)
    umask 022
    mkdir -p "$root/incoming" "$root/releases" "$root/shared"
    [[ ! -e "$target" && ! -L "$target" ]] || exit 3
    [[ ! -e "$current" || -L "$current" || -d "$current" ]] || exit 3
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
    [[ ! -e "$next" && ! -L "$next" && ! -e "$previous_backup" && ! -L "$previous_backup" ]] || exit 3
    cp -a "$target" "$next"
    chmod 755 "$next"
    if [[ -e "$current" || -L "$current" ]]; then
      php -r 'if (!rename($argv[1], $argv[2])) exit(1);' "$current" "$previous_backup"
      printf '%s' "$previous_backup" > "$previous_file"
    else
      printf '' > "$previous_file"
    fi
    php -r 'if (!rename($argv[1], $argv[2])) exit(1);' "$next" "$current"
    ;;
  rollback)
    [[ -f "$previous_file" && -f "$current/manifest.json" && -f "$target/manifest.json" ]] || exit 3
    cmp -s "$current/manifest.json" "$target/manifest.json" || exit 3
    previous="$(cat "$previous_file")"
    rm -rf "$current"
    if [[ -n "$previous" ]]; then
      [[ "$previous" == "$previous_backup" && ( -d "$previous" || -L "$previous" ) ]] || exit 3
      php -r 'if (!rename($argv[1], $argv[2])) exit(1);' "$previous" "$current"
    fi
    ;;
  *) exit 2 ;;
esac
