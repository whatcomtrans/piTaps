# S3 Fleet Config — Setup & Migration Guide

This guide covers two things:
1. **One-time AWS setup** — create the S3 bucket, config file, and IAM credentials (do this first, once)
2. **Migrate an already-deployed Pi** — update the running Pi to use S3 instead of local `.env` values

---

## Part 1 — AWS Setup (do this once)

### Step 1 — Create the S3 bucket

1. Open the [AWS S3 console](https://s3.console.aws.amazon.com/s3/) and click **Create bucket**.
2. **Bucket name**: choose something like `wta-pitaps-config` (must be globally unique).
3. **Region**: `us-west-2` (same region as your API Gateway).
4. Leave all other settings at their defaults (block public access ON — this bucket should be private).
5. Click **Create bucket**.

---

### Step 2 — Create the config file and upload it

Create a file on your PC named `pitaps-config.json`:

```json
{
  "SERVER_URL": "https://825cvaskdc.execute-api.us-west-2.amazonaws.com/prod/taps",
  "API_KEY": "your-real-api-key-here"
}
```

Upload it to your bucket:

**AWS Console:**
1. Open your bucket → click **Upload** → **Add files** → select `pitaps-config.json`.
2. Leave all settings at defaults → click **Upload**.

**AWS CLI (if installed):**
```bash
aws s3 cp pitaps-config.json s3://wta-pitaps-config/pitaps-config.json
```

> **To update the API endpoint or key in future:** edit `pitaps-config.json` and re-upload. All Pis will pick up the new values on their next reboot. No Pi access needed.

---

### Step 3 — Create an IAM policy

1. Open the [IAM console](https://console.aws.amazon.com/iam/) → **Policies** → **Create policy**.
2. Switch to the **JSON** editor and paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::wta-pitaps-config/pitaps-config.json"
    }
  ]
}
```

> Replace `wta-pitaps-config` with your actual bucket name.

3. Click **Next** → name it `pitaps-config-read` → click **Create policy**.

---

### Step 4 — Create an IAM user and get credentials

1. In the IAM console → **Users** → **Create user**.
2. **User name**: `pitaps-pi` (or similar).
3. On the **Set permissions** page, choose **Attach policies directly** → search for and select `pitaps-config-read`.
4. Click through to **Create user**.
5. Open the new user → **Security credentials** tab → **Create access key**.
6. Choose **Application running outside AWS** → click **Next** → **Create access key**.
7. **Copy both the Access key ID and Secret access key now** — the secret is only shown once.

---

## Part 2 — Migrate the Already-Deployed Pi

SSH into the Pi:

```bash
ssh pitaps@192.168.0.11
# or via port-forward: ssh -p 2222 pitaps@<vehicle-wwan-ip>
```

### Step 5 — Update `.env`

Open the env file:

```bash
sudo nano /opt/pitaps/.env
```

**Remove** these lines (they move to S3):
```
SERVER_URL=...
API_KEY=...
```

**Add** these lines (use the values from Step 4):
```
AWS_REGION=us-west-2
S3_CONFIG_BUCKET=wta-pitaps-config
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Lock down the file permissions:
```bash
sudo chmod 600 /opt/pitaps/.env
```

---

### Step 6 — Install the new dependency

The updated `package.json` adds `@aws-sdk/client-s3`. Install it now (the service will do this automatically on future reboots, but you need it before the first restart):

```bash
cd /opt/pitaps
npm install --omit=dev
```

This will take a minute or two on the Pi 2.

---

### Step 7 — Pull the latest code

```bash
git -C /opt/pitaps pull
```

---

### Step 8 — Restart the service

```bash
sudo systemctl restart pitaps
```

---

### Step 9 — Verify

Watch the logs for a successful S3 fetch:

```bash
journalctl -u pitaps -f
```

You should see a line like:
```
[Config] Fleet config loaded (SERVER_URL, API_KEY)
```

If you see a warning instead, check the specific error message — common causes:
- Typo in `S3_CONFIG_BUCKET` name
- Wrong `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- IAM policy not attached to the user
- `pitaps-config.json` not uploaded to the bucket

If S3 fails but the app continues running, it found a cached copy from a previous fetch (`/opt/pitaps/remote_config_cache.json`). Fix the S3 issue and restart again to confirm a clean fetch.

---

## Updating the config in future

To change `SERVER_URL` or `API_KEY` fleet-wide:

1. Edit `pitaps-config.json` on your PC.
2. Upload it to S3 (overwrite the existing file).
3. Each Pi picks up the new values on its **next reboot** — no SSH access needed.

To force an immediate update on one Pi without rebooting:
```bash
sudo systemctl restart pitaps
```
