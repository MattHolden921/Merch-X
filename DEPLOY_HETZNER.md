# Deploy Merch X on Hetzner with GitHub

This setup uses a small Hetzner Cloud VPS, Caddy for HTTPS, systemd to keep the Node app running, and GitHub Actions to deploy on every push to `main`.

## 1. Create the server

In Hetzner Cloud:

- Create an Ubuntu 24.04 server.
- Add your SSH public key.
- Add a firewall allowing inbound `22`, `80`, and `443`.
- Point your domain DNS `A` record to the server IPv4 address.

## 2. Prepare the server

SSH in:

```bash
ssh root@YOUR_SERVER_IP
```

Install the basics:

```bash
apt update
apt install -y git nodejs npm caddy
```

Create the app folder:

```bash
mkdir -p /opt/merch-x
cd /opt/merch-x
git clone YOUR_GITHUB_REPO_URL .
npm install --omit=dev
```

Create persistent app storage:

```bash
mkdir -p /var/lib/merch-x/uploads
chown -R root:root /var/lib/merch-x
```

This uploads folder holds invoice files and order/product images. If you attach a Hetzner Volume later, mount it at `/var/lib/merch-x` or `/var/lib/merch-x/uploads` and keep the same `UPLOADS_DIR` value.

Create the production environment:

```bash
nano /opt/merch-x/.env
```

Use:

```text
APP_USERNAME=merch
APP_PASSWORD=use-a-long-random-password
PORT=3000
DATABASE_PATH=/var/lib/merch-x/merch-x.sqlite
UPLOADS_DIR=/var/lib/merch-x/uploads
SHOPIFY_SHOP=your-store
SHOPIFY_CLIENT_ID=your-client-id
SHOPIFY_CLIENT_SECRET=your-client-secret
SHOPIFY_API_VERSION=2026-07
WINDSOR_API_KEY=your-windsor-api-key
WINDSOR_ACCOUNT_NAME_CONTAINS=kit,kaboodal
# Optional exact ad-account allowlists after confirming Windsor account IDs.
WINDSOR_GOOGLE_ACCOUNT_IDS=
WINDSOR_META_ACCOUNT_IDS=
WINDSOR_GOOGLE_ACCOUNT_PARAM=account_id
WINDSOR_META_ACCOUNT_PARAM=account
```

The P&L planner uses ShopifyQL sales reports, which require a Shopify Admin GraphQL schema that exposes `shopifyqlQuery`. If the live site reports that `shopifyqlQuery` does not exist on `QueryRoot`, check `/opt/merch-x/.env` and update `SHOPIFY_API_VERSION` to `2026-07`, then restart `merch-x`.

## 3. Run with systemd

Create:

```bash
nano /etc/systemd/system/merch-x.service
```

Paste:

```ini
[Unit]
Description=Merch X
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/merch-x
EnvironmentFile=/opt/merch-x/.env
ExecStart=/usr/bin/node /opt/merch-x/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
systemctl daemon-reload
systemctl enable --now merch-x
systemctl status merch-x
```

## 4. Put Caddy in front

Edit:

```bash
nano /etc/caddy/Caddyfile
```

Use your real domain:

```caddyfile
merch.yourdomain.com {
	reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Caddy will request and renew HTTPS certificates automatically once DNS points at the server.

## 5. Connect GitHub Actions

On GitHub, add repository secrets:

```text
HETZNER_HOST=YOUR_SERVER_IP
HETZNER_USER=root
HETZNER_SSH_KEY=your-private-deploy-key
```

The workflow in `.github/workflows/deploy.yml` will SSH into the server, pull the latest code, install production dependencies, and restart `merch-x`.

## 6. Deploy

Push to `main`:

```bash
git push origin main
```

Then visit:

```text
https://merch.yourdomain.com
```

The browser should ask for the username and password from `/opt/merch-x/.env`.
