# Chekku nginx reverse proxy

Template site config for putting nginx in front of the Chekku client in production. The client container publishes `127.0.0.1:3000` (loopback only, by design — see `docs/OPERATIONS.md`); nginx terminates TLS on `:443` and proxies to it.

This is operator deployment infra. It is **not** part of the Chekku Compose stack — install it on the host or wherever your reverse proxy lives.

## What it does

- `:80` serves the Let's Encrypt ACME challenge path, redirects everything else to `:443`.
- `:443` terminates TLS (Let's Encrypt cert paths) and proxies to `127.0.0.1:3000`.
- Forwards `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`. Two headers are load-bearing:
  - `X-Forwarded-For` is set to `$remote_addr` (overwrite, not append). The app's `clientIp()` reads the **leftmost** XFF entry; appending (`$proxy_add_x_forwarded_for`) would let any client spoof that entry and get a fresh rate-limit bucket per request when `RATE_LIMIT_TRUST_PROXY=true`. **Behind a CDN that appends to XFF (e.g. Cloudflare), the CDN's leftmost entry is attacker-supplied** — the same overwrite is still required, and if you cannot enforce it at your edge, leave `RATE_LIMIT_TRUST_PROXY` unset.
  - `Host` keeps redirect/cookie URLs on the public origin. The remaining headers are hygiene; Better Auth resolves its base URL from the `BETTER_AUTH_URL` env var, not from forwarded headers.
- `proxy_buffering off` + `gzip off` so streamed agent responses (`text/event-stream`) arrive token-by-token instead of quantized.
- Passes `Upgrade`/`Connection` headers for WebSocket / SSE (Next.js HMR in dev, streamed agent responses in prod).

## Install

Order matters on a fresh host: the `:443` block references certificate files, so `nginx -t` fails until certs exist.

1. Install nginx and certbot on the host:

   ```bash
   sudo apt update
   sudo apt install -y nginx certbot
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
       ''      "";
   }
   ```

4. Bootstrap certificates **before** enabling the site. Simplest path — certbot's standalone server (briefly stops nginx):

   ```bash
   sudo systemctl stop nginx
   sudo certbot certonly --standalone -d studio.example.com
   sudo systemctl start nginx
   ```

   (Alternative: keep the packaged `default` site enabled and use `sudo certbot certonly --webroot -w /var/www/html -d studio.example.com`; remove the default site afterwards.)

5. Enable the site and verify:

   ```bash
   sudo ln -s /etc/nginx/sites-available/chekku.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   curl -I https://studio.example.com/
   ```

6. Persist the renewal reload hook. A command-line `--deploy-hook` on `certbot renew` applies to that manual run only and is **not** remembered by `certbot.timer`; without a persisted hook the next automatic renewal swaps certs without reloading nginx and the site serves the old certificate. Use the renewal-hooks directory:

   ```bash
   sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<< 'systemctl reload nginx'
   sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
   ```

7. Open the firewall if applicable:

   ```bash
   sudo ufw allow 80,443/tcp
   ```

8. Update `client/.env.local` and rebuild the client so the new origin reaches the browser bundle:

   ```dotenv
   BETTER_AUTH_URL=https://studio.example.com
   NEXT_PUBLIC_APP_URL=https://studio.example.com
   RATE_LIMIT_TRUST_PROXY=true
   ```

   `NEXT_PUBLIC_APP_URL` is inlined by `next build`, so a rebuild is required after changing it. `BETTER_AUTH_URL` is server-runtime only (no rebuild needed, but set both at once). Set `RATE_LIMIT_TRUST_PROXY=true` only because this template overwrites `X-Forwarded-For` with `$remote_addr` — see "What it does" above.

## Renewal

certbot installs a systemd timer (`certbot.timer`) that renews automatically. The reload hook installed in step 6 runs after each successful renewal. A manual `sudo certbot renew --dry-run` verifies the whole path.

## Customization

- **Custom client port**: if `CHEKKU_CLIENT_HOST_PORT` overrides `3000` in `client/.env.local`, update `proxy_pass` to match.
- **Larger uploads**: raise `client_max_body_size` if the studio handles big attachments.
- **Faster stream failure**: `proxy_read_timeout` (600s) is the max gap between bytes, not total duration; tune down if you prefer faster 504s on stuck agent turns.
- **Static asset caching**: the optional `/_next/static/` block in the config can be enabled when you mount the client's `.next/static/` onto the host. Note that any `add_header` in that block suppresses the inherited HSTS/security headers for that location.
- **Behind Cloudflare / CDN**: nginx becomes a backend, not the edge. The `$remote_addr` XFF overwrite is still required — a CDN that appends to XFF leaves its leftmost entry attacker-controlled. If you cannot enforce an overwrite at the CDN, leave `RATE_LIMIT_TRUST_PROXY` unset and the limiter collapses spoofed traffic into one shared bucket.
