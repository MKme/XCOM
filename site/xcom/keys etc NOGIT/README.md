# XCOM license proxy + secrets (server maintenance)

XCOM is a **static PWA**. The WooCommerce License Manager API (LMFWC) requires a Woo **consumer key/secret**, and those secrets **must never** be shipped in browser JavaScript.

So XCOM validates license keys via a tiny server-side proxy endpoint:

- App: `https://mkme.org/xcom/` (static files)
- Proxy: `https://mkme.org/xcom/license.php` (PHP, talks to `store.mkme.org` with secrets server-side)

This folder contains the **server-side** files you deploy to `mkme.org` (not the store).

---

## What to upload (mkme.org)

Create/locate this folder on your server:

- `/xcom/`  (public)

Place these files in `/xcom/`:

- `license.php` (proxy endpoint)
- `.htaccess` (blocks secrets + keeps SPA routing from stealing `license.php`)

Create this file in `/xcom/` (do **not** commit it to git):

- `.xcom-license-secrets.php` (your real Woo consumer key/secret)

Template is in this repo:

- `.xcom-license-secrets.php.example` → copy to `.xcom-license-secrets.php`

---

## Secrets file contents

`/xcom/.xcom-license-secrets.php` must return a PHP array like:

```php
<?php
return [
  'consumerKey' => 'ck_REPLACE_ME',
  'consumerSecret' => 'cs_REPLACE_ME',
  'apiBase' => 'https://store.mkme.org/wp-json/lmfwc/v2',
  // Required: WooCommerce product id for XCOM (prevents other product keys from unlocking XCOM)
  'productId' => 12345,
];
```

Notes:

- `apiBase` points to the **store** site (not `mkme.org`).
- Keep the secrets file readable by PHP, but **blocked from web access** via `.htaccess`.

---

## Optional: environment variables instead of a secrets file

If your hosting supports env vars in PHP, `license.php` also accepts:

- `XCOM_WOO_CONSUMER_KEY`
- `XCOM_WOO_CONSUMER_SECRET`
- `XCOM_STORE_LM_API_BASE` (optional; defaults to `https://store.mkme.org/wp-json/lmfwc/v2`)
- `XCOM_STORE_LM_PRODUCT_ID` (**required**; WooCommerce product id(s) for XCOM; comma-separated allowed)

If env vars are missing, it falls back to `.xcom-license-secrets.php`.

---

## How to create the Woo REST API key (store.mkme.org)

In `https://store.mkme.org/wp-admin/`:

1. WooCommerce → Settings → Advanced → **REST API**
2. Add Key:
   - Permissions: **Read** (recommended)
3. Copy the **consumer key** (`ck_...`) and **consumer secret** (`cs_...`) into `.xcom-license-secrets.php`.

---

## Test the proxy (recommended every time you change secrets)

### 1) Self-test (checks store auth + connectivity)

Open:

- `https://mkme.org/xcom/license.php?selftest=1`

Expected:

- `success: true`
- `store_status: 200` (or other 2xx)

### 2) Activate / validate a real license key

PowerShell:

```powershell
curl.exe -sS -X POST "https://mkme.org/xcom/license.php" -H "Content-Type: application/json" --data "{\"license_key\":\"YOUR-KEY\",\"action\":\"activate\"}"
```

Validate-only (does not increment activations):

```powershell
curl.exe -sS -X POST "https://mkme.org/xcom/license.php" -H "Content-Type: application/json" --data "{\"license_key\":\"YOUR-KEY\",\"action\":\"validate\"}"
```

Expected:

- Valid key: `{ "success": true }`
- Invalid key: `{ "success": false, ... }` (usually HTTP 401)

---

## What XCOM does with licenses (behavior)

- Users must activate once while online (increments the store activation count).
- After activation, XCOM caches the key + “licensed ok” locally and runs offline on that device.
- **Update button:** if the proxy is reachable, XCOM re-validates the cached license key (does not increment activations); it only forces re-activation when the license is **invalid**. If the proxy is unreachable, it will **not** block updates.
