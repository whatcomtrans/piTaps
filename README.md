# piTaps — Raspberry Pi Card Tap Reader

Reads card taps from an Elatec TWN4 MultiTech2 USB card reader, queues them locally, and sends batches to an AWS API endpoint. Designed to run on a Raspberry Pi 2 installed on a transit vehicle, connected via Ethernet to a Cradlepoint R1900 cellular router.

```
[Elatec TWN4]──USB──[Raspberry Pi 2]──Ethernet──[Cradlepoint R1900]──Cellular──[AWS API]
                       192.168.0.11                  192.168.0.1
```

---

## Prerequisites

- Raspberry Pi 2 Model B
- 8 GB (or larger) microSD card
- Ethernet cable
- Elatec TWN4 MultiTech2 LF/HF card reader (USB CDC Serial mode)
- PC with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) installed
- Cradlepoint R1900 router configured on the vehicle LAN

---

## Step 1 — Flash the SD Card

1. Open **Raspberry Pi Imager** on your PC.
2. Click **Choose OS** → **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite (32-bit)**.
   > In Raspberry Pi Imager the entry is described as *"a port of Debian Trixie with no desktop environment"*. Select that — do **not** look for a "Legacy" or "Bullseye" label, as the imager doesn't use those terms in the description.
3. Click **Choose Storage** and select your SD card.
4. Click the **gear icon** (⚙) to open OS Customization settings:
   - **Set hostname**: `pitaps` *(every Pi in the fleet uses the same hostname — vehicle identity comes from the router, not the Pi)*
   - **Enable SSH**: checked, **Use password authentication**
   - **Set username and password**: username `pitaps`, choose a strong password
   - **Locale settings**: set your timezone
5. Click **Save**, then **Write**. Wait for flashing and verification to complete.

---

## Step 2 — Pre-Boot Configuration (Boot Partition)

Before inserting the SD card into the Pi, add one file to the **boot partition**. The boot partition is FAT32 and mounts automatically on Windows or macOS when the SD card is inserted.

Copy [`.env.example`](.env.example) to a file named `pitaps.env` and fill in the real values:

```
SERVER_URL=https://YOUR-ID.execute-api.us-west-2.amazonaws.com/prod/taps
API_KEY=your-real-api-key
GITHUB_REPO_URL=https://github.com/YOUR-ORG/piTaps.git
ROUTER_HOST=192.168.0.1
ROUTER_API_USERNAME=
ROUTER_API_PASSWORD=
```

Copy `pitaps.env` to the **root of the boot partition** (the drive that appears as `bootfs` or `boot` when mounted on your PC).

> On Raspberry Pi OS Trixie the boot partition is mounted at `/boot/firmware` on the running Pi — not `/boot`. If you ever need to access it from the Pi itself, use that path.

> **This file is identical for every Pi in the fleet.** Vehicle identity (bus number) is read at runtime from the Cradlepoint router's SDK appdata — no per-Pi customization is needed on the SD card.

Eject the SD card and insert it into the Pi.

---

## Step 3 — First Boot & SSH Access

Power on the Pi (Ethernet connected to the Cradlepoint).

The Pi will boot and obtain a DHCP address initially. Find its IP from the Cradlepoint's connected-clients list, or use:

```bash
ssh pitaps@pitaps.local
```

> `pitaps.local` resolves via mDNS on most networks. If it doesn't resolve, use the DHCP IP shown in the Cradlepoint's client list.

---

## Step 4 — Static IP Address

Assign the Pi a static IP of `192.168.0.11` on the Ethernet interface. Raspberry Pi OS (Debian Trixie) uses **NetworkManager** — the `dhcpcd` service is not present.

First, confirm the connection name (it will be `netplan-eth0` on a fresh Trixie image):

```bash
nmcli con show
```

Then apply the static IP configuration using that connection name:

```bash
sudo nmcli con mod "netplan-eth0" \
  ipv4.method manual \
  ipv4.addresses 192.168.0.11/24 \
  ipv4.gateway 192.168.0.1 \
  ipv4.dns "8.8.8.8 8.8.4.4"

sudo nmcli con up "netplan-eth0"
```

The change takes effect immediately — no reboot required. Verify:

```bash
ip addr show eth0
# Should show inet 192.168.0.11/24
```

From now on SSH using the static IP:

```bash
ssh pitaps@192.168.0.11
```

---

## Step 5 — Install Node.js

> **Note:** NodeSource does not support `armhf` (32-bit ARMv7). Do not use the NodeSource setup script — it will fail with an "Unsupported architecture" error on the Pi 2.

### Option A — Debian repository (try this first)

```bash
sudo apt update && sudo apt install -y nodejs npm
node --version
```

If this prints `v18.x` or higher, you're done. Proceed to Step 6.

### Option B — Official Node.js binary (if Option A gives an older version)

The nodejs.org distribution site provides official `armv7l` binaries for all LTS releases. Check [nodejs.org/en/download](https://nodejs.org/en/download) for the current LTS version number, then:

```bash
NODE_VERSION="v20.18.3"   # replace with current LTS from nodejs.org if newer
wget -q https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-armv7l.tar.xz
tar -xf node-${NODE_VERSION}-linux-armv7l.tar.xz
sudo cp -r node-${NODE_VERSION}-linux-armv7l/. /usr/local/
rm -rf node-${NODE_VERSION}-linux-armv7l node-${NODE_VERSION}-linux-armv7l.tar.xz
```

Verify:

```bash
node --version   # should print v20.x.x
npm --version
```

---

## Step 6 — Deploy piTaps

Create the installation directory and clone the repository:

```bash
sudo mkdir -p /opt/pitaps
sudo chown pitaps:pitaps /opt/pitaps

git clone https://github.com/YOUR-ORG/piTaps.git /opt/pitaps
cd /opt/pitaps
npm install --omit=dev
```

Copy your `.env` file into place (if the first-boot script hasn't already done so):

```bash
# Only needed if you're doing a manual install (not using the golden image workflow)
sudo cp /boot/firmware/pitaps.env /opt/pitaps/.env
sudo chown pitaps:pitaps /opt/pitaps/.env
sudo chmod 600 /opt/pitaps/.env
```

Test the app runs:

```bash
cd /opt/pitaps
node index.js
# Press Ctrl+C to stop
```

---

## Step 7 — systemd Service (Auto-Start & Keep Running)

The service file pulls the latest code from GitHub and installs any new dependencies every time it starts, providing automatic over-the-air updates on every reboot.

```bash
# Copy the service files
sudo cp /opt/pitaps/setup/pitaps.service /etc/systemd/system/
sudo cp /opt/pitaps/setup/pitaps-firstboot.service /etc/systemd/system/
sudo cp /opt/pitaps/setup/first-boot.sh /opt/pitaps/setup/first-boot.sh
sudo chmod +x /opt/pitaps/setup/first-boot.sh

# Reload systemd and enable the main service
sudo systemctl daemon-reload
sudo systemctl enable pitaps
sudo systemctl start pitaps

# Check status
sudo systemctl status pitaps
```

The service will:
- Start automatically on every boot
- Pull the latest code from GitHub before starting
- Restart itself automatically within 5 seconds if it crashes

---

## Step 8 — Log Management

piTaps logs to the systemd journal. Configure journald to cap total log storage at 200 MB and automatically remove logs older than two weeks — well within the 500 MB target.

```bash
sudo nano /etc/systemd/journald.conf
```

Find the `[Journal]` section and set:

```ini
[Journal]
SystemMaxUse=200M
SystemKeepFree=50M
MaxRetentionSec=2week
```

Apply:

```bash
sudo systemctl restart systemd-journald
```

### Viewing logs

```bash
# Live log stream for the piTaps service
journalctl -u pitaps -f

# Last 100 lines
journalctl -u pitaps -n 100

# Logs since last boot
journalctl -u pitaps -b

# Check total journal disk usage
journalctl --disk-usage
```

---

## Step 9 — Automatic Updates on Reboot

Updates are handled automatically by the systemd service. Every time the Pi reboots, the service runs:

```
git pull            ← pulls any new commits from GitHub
npm install         ← installs any new dependencies
node index.js       ← starts the app
```

This is configured via `ExecStartPre` directives in [`setup/pitaps.service`](setup/pitaps.service). No cron jobs or additional configuration are needed.

**To deploy an update to the fleet:** push your changes to the `main` branch on GitHub. The next time each vehicle's Pi reboots, it will pull and run the new code automatically.

---

## Step 10 — Remote Access

Remote SSH access is provided by a single port-forwarding rule on the Cradlepoint. You SSH directly to the router's known WWAN IP on an external port, and the router forwards the connection to the Pi.

> **Important caveat:** Some cellular carriers block inbound TCP connections at the APN level. If port forwarding doesn't work after configuration, contact your carrier to confirm inbound TCP is permitted on your SIM plan. As a fallback, [Tailscale](https://tailscale.com) (free tier) can provide reliable SSH access without any port forwarding or carrier cooperation.

### 10a. Configure Port Forwarding on the Cradlepoint

1. In the Cradlepoint UI go to **Network → Local Networks → Port Forwarding**.
2. Add a rule:
   - **External port**: `2222` (avoid 22 to reduce automated scanning)
   - **Internal IP**: `192.168.0.11`
   - **Internal port**: `22`
   - **Protocol**: TCP
3. Save and apply.

This rule is identical for every vehicle — it only needs to be configured once per router and can be pushed via NetCloud Manager to the entire fleet simultaneously.

### 10b. Harden SSH on the Pi

Disable password authentication and use SSH key pairs:

```bash
# On your admin workstation, copy your public key to the Pi (while on the local LAN)
ssh-copy-id -p 22 pitaps@192.168.0.11

# On the Pi, disable password login
sudo nano /etc/ssh/sshd_config
```

Set:
```
PasswordAuthentication no
PermitRootLogin no
```

```bash
sudo systemctl restart ssh
```

### 10c. Connect Remotely

Look up the vehicle's current WWAN IP (from your router inventory or NetCloud Manager), then:

```bash
ssh -p 2222 pitaps@<vehicle-wwan-ip>
```

Keep a simple spreadsheet mapping vehicle numbers to their WWAN IPs. If the WWAN IP changes (e.g. after a router reboot on cellular), update the record from NetCloud Manager.

---

## Fleet Deployment (50+ Units)

Every Pi in the fleet is **identical** — same image, same config, same local IP. Vehicle identity comes from the Cradlepoint router's appdata, not from the Pi itself. This makes mass deployment straightforward.

### Create the Golden Image

1. Complete Steps 1–10 on a single "master" Pi.
2. Shut it down cleanly: `sudo shutdown -h now`.
3. Remove the SD card and insert it into your PC.
4. Clone the image:

**Linux/macOS:**
```bash
sudo dd if=/dev/sdX bs=4M status=progress | gzip > pitaps-golden.img.gz
```

**Windows:** Use [Win32DiskImager](https://win32diskimager.org) or [balenaEtcher](https://etcher.balena.io) to read the card to an `.img` file.

### Flash Each Vehicle Card

```bash
# Write golden image to a new SD card
gunzip -c pitaps-golden.img.gz | sudo dd of=/dev/sdY bs=4M status=progress
```

Or use Raspberry Pi Imager → **Use custom image** and select `pitaps-golden.img`.

### One File on the Boot Partition (Same for All)

After flashing, mount the boot partition (it appears as a small FAT32 drive) and copy:

| File | Contents | Same for all? |
|---|---|---|
| `pitaps.env` | Your real `.env` file | ✅ Yes — identical for every vehicle |

That's it. The first-boot script:
- Regenerates unique SSH host keys (so each Pi is cryptographically distinct even though the image is identical)
- Moves `.env` into place
- Enables and starts the piTaps service

**Flashing workflow per card (~5 minutes each):**
1. Flash golden image → SD card
2. Mount boot partition → copy `pitaps.env` (same file every time, no changes)
3. Eject → insert into Pi → done

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVER_URL` | ✅ | — | AWS API Gateway endpoint URL |
| `API_KEY` | ✅ | — | API authentication key sent as `x-api-key` header |
| `GITHUB_REPO_URL` | ✅ | — | Public GitHub repo URL for auto-updates |
| `ROUTER_HOST` | — | `192.168.0.1` | Cradlepoint router IP for GPS and vehicle ID lookup |
| `ROUTER_API_USERNAME` | — | *(empty)* | Cradlepoint API username (if required) |
| `ROUTER_API_PASSWORD` | — | *(empty)* | Cradlepoint API password (if required) |

---

## Troubleshooting

**App won't start — "FATAL: SERVER_URL and API_KEY must be set"**
The `.env` file is missing or incomplete. Check `/opt/pitaps/.env` exists and contains both required variables.

**No card reads — "No serial device found"**
- Confirm the Elatec reader is plugged into a USB port: `ls /dev/ttyACM* /dev/ttyUSB*`
- Check USB is recognized: `lsusb`
- Check reader mode is set to USB CDC Serial (not HID) in the Elatec configuration

**Update on reboot not working**
- Confirm the Pi has internet access: `ping 8.8.8.8`
- Check the git pull step: `sudo -u pitaps git -C /opt/pitaps pull`
- Verify `GITHUB_REPO_URL` is set correctly in `.env`

**Can't SSH from outside the vehicle**
- Confirm the port-forward rule (WAN:2222 → 192.168.0.11:22) is active in the Cradlepoint UI
- Verify you have the correct current WWAN IP for that vehicle (check NetCloud Manager)
- Check your carrier allows inbound TCP — some cellular APNs block it by default

**Check live logs**
```bash
journalctl -u pitaps -f
```

**Check disk usage**
```bash
df -h /
journalctl --disk-usage
