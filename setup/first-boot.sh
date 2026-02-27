#!/bin/bash
# =============================================================================
# piTaps First-Boot Setup Script
#
# This script runs ONCE on first boot via the pitaps-firstboot.service unit.
# It reads one file from the FAT32 boot partition (writable from any PC):
#
#   /boot/pitaps.env  — copy of your real .env file (with secrets)
#                       This file is IDENTICAL for every Pi in the fleet.
#
# Vehicle identity is fetched at runtime from the Cradlepoint router's
# SDK appdata (vehicleID field) — no per-Pi configuration is needed here.
#
# After configuring the system it disables itself so it never runs again.
# =============================================================================

set -euo pipefail

BOOT=/boot/firmware  # Raspberry Pi OS Bookworm / Trixie mount point for the FAT32 boot partition
INSTALL=/opt/pitaps
LOG=/var/log/pitaps-firstboot.log

exec >> "$LOG" 2>&1
echo "=== piTaps first-boot setup: $(date) ==="

# -----------------------------------------------------------------------------
# 1. Regenerate SSH host keys (critical — cloned images share the same keys)
# -----------------------------------------------------------------------------
echo "Regenerating SSH host keys..."
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
echo "SSH host keys regenerated."

# -----------------------------------------------------------------------------
# 2. Copy .env from boot partition to install location
# -----------------------------------------------------------------------------
if [ -f "$BOOT/pitaps.env" ]; then
    mkdir -p "$INSTALL"
    cp "$BOOT/pitaps.env" "$INSTALL/.env"
    chown pitaps:pitaps "$INSTALL/.env"
    chmod 600 "$INSTALL/.env"
    echo ".env copied to $INSTALL/.env"
else
    echo "WARNING: $BOOT/pitaps.env not found — app will not start without it"
fi

# -----------------------------------------------------------------------------
# 3. Clone piTaps repository (if not already present from golden image)
# -----------------------------------------------------------------------------
if [ -f "$INSTALL/.env" ]; then
    REPO_URL=$(grep '^GITHUB_REPO_URL=' "$INSTALL/.env" | cut -d= -f2-)
    if [ -n "$REPO_URL" ] && [ ! -d "$INSTALL/.git" ]; then
        echo "Cloning $REPO_URL into $INSTALL..."
        git clone "$REPO_URL" "$INSTALL"
        chown -R pitaps:pitaps "$INSTALL"
        cd "$INSTALL"
        sudo -u pitaps npm install --omit=dev
        echo "Repository cloned and dependencies installed."
    fi
fi

# -----------------------------------------------------------------------------
# 4. Enable and start the piTaps service now that setup is complete
# -----------------------------------------------------------------------------
systemctl enable pitaps
systemctl start pitaps
echo "pitaps service enabled and started."

# -----------------------------------------------------------------------------
# 5. Disable this first-boot service so it never runs again
# -----------------------------------------------------------------------------
systemctl disable pitaps-firstboot
echo "=== First-boot setup complete ==="
