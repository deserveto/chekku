# Chekku nginx reverse proxy

Template site config for putting nginx in front of the Chekku client in production. The client container publishes `127.0.0.1:3000` (loopback only, by design — see `docs/OPERATIONS.md`); nginx terminates TLS on `:443` and proxies to it.

This is operator deployment infra. It is **not** part of the Chekku Compose stack — install it on the host or wherever your reverse proxy lives.

## What it does

- `:80` serves the Let's Encrypt ACME challenge path, redirects everything else to `:443`.
- `:443` terminates TLS (Let's Encrypt cert paths) and proxies to `127.0.0.1:3000`.
- Forwards `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` so:
  - Better Auth sees the real browser origin and protocol (session cookies and verification links depend on this).
  - The in-process auth rate limiter sees the real client IP **only when** `RATE_LIMIT_TRUST_PROXY=true` is set in `client/.env.local`. Without that flag, the limiter ignores `x-forwarded-for` and every anonymous client shares one bucket per scope (safer default).
- Passes `Upgrade`/`Connection` headers for WebSocket / SSE (Next.js HMR in dev, streamed agent responses in prod).

## Install

1. Install nginx and certbot on the host:

   ```bash
   sudo apt update
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. Copy the config and replace the placeholder hostname:

   ```bash
   sudo cp ops/nginx/chekku.conf /etc/nginx/sites-available/chekku.conf
   sudo sed -i 's/CHEKKU_HOSTNAME/studio.example.com/g' /etc/nginx/sites-available/chekku.conf
   ```

3. Add the WebSocket upgrade map (referenced by `$connection_upgrade`). Either put it in `/etc/nginx/conf.d/upgrade.conf` or inside the existing `http {}` block:

   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       ''      close;
   }
   ```

4. Enable the site:

   ```bash
   sudo ln -s /etc/nginx/sites-available/chekku.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   ```

5. Get Let's Encrypt certs (this fills in the `ssl_certificate` paths the config references):

   ```bash
   sudo certbot certonly --webroot -w /var/www/html -d studio.example.com
   ```

6. Reload and verify:

   ```bash
   sudo systemctl reload nginx
   curl -I https://studio.example.com/
   ```

7. Update `client/.env.local` and rebuild the client so the new origin reaches the browser bundle:

   ```dotenv
   BETTER_AUTH_URL=https://studio.example.com
   NEXT_PUBLIC_APP_URL=https://studio.example.com
   RATE_LIMIT_TRUST_PROXY=true
   ```

   `NEXT_PUBLIC_APP_URL` is inlined by `next build`, so a rebuild is required after changing it.

## Renewal

certbot installs a systemd timer (`certbot.timer`) that renews automatically. The standard `--deploy-hook` reloads nginx after each successful renewal:

```bash
sudo certbot renew --deploy-hook "systemctl reload nginx"
```

## Customization

- **Custom client port**: if `CHEKKU_CLIENT_HOST_PORT` overrides `3000` in `client/.env.local`, update `proxy_pass` to match.
- **Larger uploads**: raise `client_max_body_size` if the studio handles big attachments.
- **Static asset caching**: the optional `/_next/static/` block in the config can be enabled when you mount the client's `.next/static/` onto the host.
- **Behind Cloudflare / CDN**: nginx becomes a backend, not the edge. Set `RATE_LIMIT_TRUST_PROXY=true` only if the CDN overwrites `x-forwarded-for` with `$remote_addr`; otherwise leave it unset and let the limiter collapse spoofed traffic.
