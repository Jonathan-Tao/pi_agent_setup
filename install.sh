#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
backup="$config/backups/pi-agent-$(date +%Y%m%d-%H%M%S)"
managed="AGENTS.md settings.json keybindings.json profiles.json agents extensions"

mkdir -p "$config"

for entry in $managed; do
    source_path="$repo/$entry"
    target_path="$config/$entry"

    if [ ! -e "$source_path" ]; then
        printf 'Missing repository entry: %s\n' "$source_path" >&2
        exit 1
    fi

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
        continue
    fi

    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
        mkdir -p "$backup"
        mv "$target_path" "$backup/$entry"
    fi

    ln -s "$source_path" "$target_path"
done

printf 'Pi configuration linked from %s\n' "$repo"
if [ -d "$backup" ]; then
    printf 'Previous files backed up to %s\n' "$backup"
fi
printf 'Restart Pi or run /reload. Changes under ~/.pi/agent now modify this repository directly.\n'
