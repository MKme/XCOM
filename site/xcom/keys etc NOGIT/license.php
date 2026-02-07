<?php
// XCOM License Proxy (for store.mkme.org)
//
// Why this exists:
// The License Manager for WooCommerce REST API on store.mkme.org requires a
// Woo consumer key/secret (Basic Auth). Those secrets MUST NOT be shipped
// inside the client (PWA) because anyone can extract them from the JS.
//
// Configure on the server (NOT in the repo):
// - XCOM_WOO_CONSUMER_KEY
// - XCOM_WOO_CONSUMER_SECRET
// - XCOM_STORE_LM_API_BASE (optional; default: https://store.mkme.org/wp-json/lmfwc/v2)
// - XCOM_STORE_LM_PRODUCT_ID (required; WooCommerce product id for XCOM)
//
// Request:
//   POST JSON: { "license_key": "XXXX" }
// Response:
//   200 { "success": true }
//   4xx/5xx { "success": false, "reason": "...", "message": "..." }

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

// Allow GET as a fallback (some hosts/WAFs strip POST bodies). Note: GET puts the
// license key in URL logs, so prefer POST for real app traffic.
$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'POST' && $method !== 'GET') {
  http_response_code(405);
  echo json_encode(["success" => false, "reason" => "method_not_allowed", "message" => "Method not allowed"]);
  exit;
}

function env_or_empty($k) {
  $v = getenv($k);
  return $v === false ? '' : $v;
}

$consumerKey = trim(env_or_empty('XCOM_WOO_CONSUMER_KEY'));
$consumerSecret = trim(env_or_empty('XCOM_WOO_CONSUMER_SECRET'));
$apiBase = trim(env_or_empty('XCOM_STORE_LM_API_BASE'));
$expectedProductId = trim(env_or_empty('XCOM_STORE_LM_PRODUCT_ID'));

function split_csv_ids($s) {
  $out = [];
  foreach (explode(',', strval($s)) as $p) {
    $t = trim($p);
    if ($t !== '') $out[] = $t;
  }
  return $out;
}

function redact_license_key_fields($s) {
  $out = strval($s);
  $out = preg_replace('/("licenseKey"\\s*:\\s*")[^"]*(")/i', '$1REDACTED$2', $out);
  $out = preg_replace('/("license_key"\\s*:\\s*")[^"]*(")/i', '$1REDACTED$2', $out);
  return $out;
}

function extract_product_id_from_node($node, $maxDepth) {
  if ($maxDepth <= 0) return '';
  if (!is_array($node)) return '';

  if (array_key_exists('productId', $node)) return trim(strval($node['productId']));
  if (array_key_exists('product_id', $node)) return trim(strval($node['product_id']));

  // Some API shapes use `product` as either a scalar id or an object.
  if (array_key_exists('product', $node)) {
    $p = $node['product'];
    if (is_scalar($p) || $p === null) return trim(strval($p));
    if (is_array($p)) {
      $sub = extract_product_id_from_node($p, $maxDepth - 1);
      if ($sub !== '') return $sub;
      if (array_key_exists('id', $p)) return trim(strval($p['id']));
    }
  }

  foreach ($node as $child) {
    if (!is_array($child)) continue;
    $found = extract_product_id_from_node($child, $maxDepth - 1);
    if ($found !== '') return $found;
  }

  return '';
}

function extract_product_id_from_validate($parsed) {
  return extract_product_id_from_node($parsed, 6);
}

function extract_license_key_from_item($item) {
  if (!is_array($item)) return '';
  if (array_key_exists('licenseKey', $item)) return trim(strval($item['licenseKey']));
  if (array_key_exists('license_key', $item)) return trim(strval($item['license_key']));
  return '';
}

function extract_license_items_from_list_response($parsed) {
  if (!is_array($parsed)) return [];
  if (array_key_exists('data', $parsed) && is_array($parsed['data'])) return $parsed['data'];
  if (function_exists('array_is_list') && array_is_list($parsed)) return $parsed;
  return [];
}

function lm_try_fetch_product_id_via_list_query($apiBase, $licenseKey, $consumerKey, $consumerSecret, $query) {
  $url = $apiBase . '/licenses?per_page=100&' . $query;
  [$status, $body, $err] = http_get_with_basic_auth($url, $consumerKey, $consumerSecret);
  if ($body === false) return '';
  if ($status < 200 || $status >= 300) return '';

  $parsed = json_decode($body, true);
  $items = extract_license_items_from_list_response($parsed);
  foreach ($items as $item) {
    if (!is_array($item)) continue;
    $itemKey = extract_license_key_from_item($item);
    if ($itemKey !== '' && hash_equals($licenseKey, $itemKey)) {
      $pid = extract_product_id_from_node($item, 3);
      if ($pid !== '') return $pid;
    }
  }

  return '';
}

function lm_find_product_id_by_listing($apiBase, $licenseKey, $consumerKey, $consumerSecret) {
  // Best-effort filters (plugin-dependent). If unsupported, we fall back to paging.
  $encoded = rawurlencode($licenseKey);
  $queries = [
    'search=' . $encoded,
    'license_key=' . $encoded,
    'licenseKey=' . $encoded,
  ];
  foreach ($queries as $q) {
    $pid = lm_try_fetch_product_id_via_list_query($apiBase, $licenseKey, $consumerKey, $consumerSecret, $q);
    if ($pid !== '') return $pid;
  }

  $perPage = 100;
  $maxPages = 10;
  for ($page = 1; $page <= $maxPages; $page++) {
    $url = $apiBase . '/licenses?per_page=' . $perPage . '&page=' . $page;
    [$status, $body, $err] = http_get_with_basic_auth($url, $consumerKey, $consumerSecret);
    if ($body === false) return '';
    if ($status < 200 || $status >= 300) return '';

    $parsed = json_decode($body, true);
    $items = extract_license_items_from_list_response($parsed);
    if (count($items) === 0) return '';

    foreach ($items as $item) {
      if (!is_array($item)) continue;
      $itemKey = extract_license_key_from_item($item);
      if ($itemKey !== '' && hash_equals($licenseKey, $itemKey)) {
        $pid = extract_product_id_from_node($item, 3);
        if ($pid !== '') return $pid;
      }
    }

    // If we got fewer than per_page results, we're at the end.
    if (count($items) < $perPage) return '';
  }

  return '';
}

function lm_try_fetch_product_id_via_direct_get($apiBase, $licenseKey, $consumerKey, $consumerSecret) {
  // If supported by the LMFWC REST API, this is the cheapest way to find a license's productId.
  $url = $apiBase . '/licenses/' . rawurlencode($licenseKey);

  [$status, $body, $err] = http_get_with_basic_auth($url, $consumerKey, $consumerSecret);
  if ($body === false) return '';
  if ($status < 200 || $status >= 300) return '';

  $parsed = json_decode($body, true);
  return extract_product_id_from_node($parsed, 6);
}

function lm_find_product_id_fallback($apiBase, $licenseKey, $consumerKey, $consumerSecret) {
  $pid = lm_try_fetch_product_id_via_direct_get($apiBase, $licenseKey, $consumerKey, $consumerSecret);
  if ($pid !== '') return $pid;

  return lm_find_product_id_by_listing($apiBase, $licenseKey, $consumerKey, $consumerSecret);
}

function extract_int_field($parsed, $field) {
  if (!is_array($parsed)) return null;

  if (isset($parsed['data']) && is_array($parsed['data'])) {
    $d = $parsed['data'];
    if (isset($d[$field]) && is_numeric($d[$field])) return intval($d[$field]);
  }

  if (isset($parsed[$field]) && is_numeric($parsed[$field])) return intval($parsed[$field]);

  return null;
}

function http_get_with_basic_auth($url, $consumerKey, $consumerSecret) {
  $err = '';
  $status = 0;
  $body = false;

  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
    curl_setopt($ch, CURLOPT_USERPWD, $consumerKey . ':' . $consumerSecret);
    curl_setopt($ch, CURLOPT_TIMEOUT, 20);
    curl_setopt($ch, CURLOPT_HEADER, false);

    $body = curl_exec($ch);
    $err = curl_error($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
  } else if (filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
    $auth = base64_encode($consumerKey . ':' . $consumerSecret);
    $context = stream_context_create([
      'http' => [
        'method' => 'GET',
        'header' => "Authorization: Basic $auth\r\n",
        'timeout' => 20,
      ],
    ]);
    $body = @file_get_contents($url, false, $context);
    if ($body === false) {
      $err = 'file_get_contents failed';
    }
    if (isset($http_response_header) && is_array($http_response_header)) {
      foreach ($http_response_header as $h) {
        if (preg_match('/^HTTP\/\\S+\\s+(\\d+)/', $h, $m)) {
          $status = intval($m[1]);
          break;
        }
      }
    }
  } else {
    $err = 'curl not available and allow_url_fopen is disabled';
  }

  return [$status, $body, $err];
}

function lm_get_license_data_or_exit($apiBase, $endpoint, $licenseKey, $consumerKey, $consumerSecret) {
  $url = $apiBase . '/licenses/' . $endpoint . '/' . rawurlencode($licenseKey);

  [$status, $body, $err] = http_get_with_basic_auth($url, $consumerKey, $consumerSecret);

  if ($body === false) {
    http_response_code(502);
    echo json_encode(["success" => false, "reason" => "upstream_unreachable", "message" => "Store request failed: " . $err]);
    exit;
  }

  $parsed = json_decode($body, true);

  if ($status < 200 || $status >= 300) {
    $msg = 'Store responded HTTP ' . $status;
    if (is_array($parsed) && isset($parsed['message'])) $msg = strval($parsed['message']);
    $snippet = substr(str_replace(["\r", "\n"], ' ', $body), 0, 220);
    if ($snippet !== '') $msg .= ' | body: ' . $snippet;

    $reason = 'upstream_error';
    $http = 502;

    if ($status === 400 || $status === 404) {
      $reason = 'invalid';
      $http = 401;
    }

    if ($status === 409) {
      $reason = 'activation_limit';
      $http = 401;
    }

    if ($status === 401 || $status === 403) {
      $reason = 'upstream_auth';
      $http = 502;
    }

    $trimBody = ltrim($body);
    $looksLikeHtml = ($trimBody !== '' && $trimBody[0] === '<');
    if ($status === 500 && $looksLikeHtml) {
      $lower = strtolower($snippet);
      if (strpos($lower, 'license') !== false && strpos($lower, 'invalid') !== false) {
        $reason = 'invalid';
        $http = 401;
        $msg = 'License invalid';
      }
    }

    http_response_code($http);
    echo json_encode(["success" => false, "reason" => $reason, "message" => $msg]);
    exit;
  }

  $ok = false;
  if (is_array($parsed)) {
    if (isset($parsed['success']) && $parsed['success'] === true) $ok = true;
    if (isset($parsed['valid']) && $parsed['valid'] === true) $ok = true;
    if (isset($parsed['status']) && $parsed['status'] === 'success') $ok = true;
  }

  if (!$ok) {
    $msg = 'License invalid';
    if (is_array($parsed) && isset($parsed['message'])) $msg = strval($parsed['message']);
    http_response_code(401);
    echo json_encode(["success" => false, "reason" => "invalid", "message" => $msg]);
    exit;
  }

  return $parsed;
}

// Fallback: load secrets from a local file for hosts where .htaccess SetEnv does not reach PHP-FPM.
// Create this file next to license.php:
//   ./.xcom-license-secrets.php
// (See .xcom-license-secrets.php.example in this repo.)
if (($consumerKey === '' || $consumerSecret === '' || $apiBase === '' || $expectedProductId === '') && file_exists(__DIR__ . '/.xcom-license-secrets.php')) {
  $secrets = include(__DIR__ . '/.xcom-license-secrets.php');
  if (is_array($secrets)) {
    if ($consumerKey === '' && isset($secrets['consumerKey'])) $consumerKey = trim(strval($secrets['consumerKey']));
    if ($consumerSecret === '' && isset($secrets['consumerSecret'])) $consumerSecret = trim(strval($secrets['consumerSecret']));
    if ($apiBase === '' && isset($secrets['apiBase'])) $apiBase = trim(strval($secrets['apiBase']));
    if ($expectedProductId === '' && isset($secrets['productId'])) $expectedProductId = trim(strval($secrets['productId']));
    if ($expectedProductId === '' && isset($secrets['product_id'])) $expectedProductId = trim(strval($secrets['product_id']));
  }
}

if ($apiBase === '') $apiBase = 'https://store.mkme.org/wp-json/lmfwc/v2';
$apiBase = rtrim($apiBase, '/');

if ($consumerKey === '' || $consumerSecret === '') {
  http_response_code(500);
  echo json_encode(["success" => false, "reason" => "server_config", "message" => "Server not configured (missing consumer key/secret)"]);
  exit;
}

if ($expectedProductId === '') {
  http_response_code(500);
  echo json_encode(["success" => false, "reason" => "server_config", "message" => "Server not configured (missing XCOM_STORE_LM_PRODUCT_ID)"]);
  exit;
}

$licenseKey = '';
$action = '';
$json = null;

if ($method === 'POST') {
  $raw = file_get_contents('php://input');
  $json = json_decode($raw, true);

  // Prefer JSON body: {"license_key":"..."}
  if (is_array($json)) {
    if (array_key_exists('license_key', $json)) $licenseKey = trim(strval($json['license_key']));
    if (array_key_exists('action', $json)) $action = trim(strval($json['action']));
    // tolerate a couple alternate client field names
    if ($licenseKey === '' && array_key_exists('licenseKey', $json)) $licenseKey = trim(strval($json['licenseKey']));
    if ($licenseKey === '' && array_key_exists('key', $json)) $licenseKey = trim(strval($json['key']));
  }

  // Fallback: allow form-encoded POSTs (some clients/proxies strip JSON bodies)
  if ($licenseKey === '' && isset($_POST['license_key'])) {
    $licenseKey = trim(strval($_POST['license_key']));
  }
  if ($action === '' && isset($_POST['action'])) {
    $action = trim(strval($_POST['action']));
  }
}

// Fallback: allow querystring (manual testing or GET fallback)
if ($licenseKey === '' && isset($_GET['license_key'])) {
  $licenseKey = trim(strval($_GET['license_key']));
}
if ($action === '' && isset($_GET['action'])) {
  $action = trim(strval($_GET['action']));
}

// Self-test mode: verify that the server can reach store.mkme.org and that the
// configured consumer key/secret are accepted.
//
// Use:
//   GET /xcom/license.php?selftest=1
//
// This returns store HTTP status and a short body snippet. It does not reveal secrets.
if (isset($_GET['selftest']) && $_GET['selftest'] === '1') {
  $testUrl = $apiBase . '/licenses?per_page=1';

  [$tStatus, $tBody, $tErr] = http_get_with_basic_auth($testUrl, $consumerKey, $consumerSecret);

  if ($tBody === false) {
    http_response_code(502);
    echo json_encode(["success" => false, "reason" => "upstream_unreachable", "message" => "Store request failed: " . $tErr]);
    exit;
  }

  $parsed = json_decode($tBody, true);
  $out = [
    "success" => ($tStatus >= 200 && $tStatus < 300),
    "mode" => "selftest",
    "store_status" => $tStatus,
  ];

  // Avoid leaking license keys in normal success responses. Only include a redacted snippet when something looks wrong.
  if (!is_array($parsed) || $tStatus < 200 || $tStatus >= 300) {
    $snippet = substr(str_replace(["\r", "\n"], ' ', $tBody), 0, 260);
    $out["body_snippet"] = redact_license_key_fields($snippet);
  } else {
    $samplePid = extract_product_id_from_validate($parsed);
    if ($samplePid !== '') $out["sample_product_id"] = $samplePid;
  }

  echo json_encode($out);
  exit;
}

if ($licenseKey === '') {
  http_response_code(400);
  echo json_encode(["success" => false, "reason" => "missing_license_key", "message" => "Missing license_key"]);
  exit;
}

$action = strtolower(trim($action));
if ($action !== 'activate' && $action !== 'validate') $action = 'validate';

$allowedProductIds = split_csv_ids($expectedProductId);
if (count($allowedProductIds) === 0) {
  http_response_code(500);
  echo json_encode(["success" => false, "reason" => "server_config", "message" => "Server not configured (empty XCOM_STORE_LM_PRODUCT_ID)"]);
  exit;
}

$validateParsed = lm_get_license_data_or_exit($apiBase, 'validate', $licenseKey, $consumerKey, $consumerSecret);

$actualProductId = extract_product_id_from_validate($validateParsed);
if ($actualProductId === '') {
  // Some LMFWC versions return a minimal validate response (no productId). In that case, look it up via the licenses list.
  $actualProductId = lm_find_product_id_fallback($apiBase, $licenseKey, $consumerKey, $consumerSecret);
}
if ($actualProductId === '') {
  http_response_code(502);
  echo json_encode(["success" => false, "reason" => "upstream_shape", "message" => "Store response missing productId"]);
  exit;
}

if (!in_array($actualProductId, $allowedProductIds, true)) {
  http_response_code(401);
  echo json_encode([
    "success" => false,
    "reason" => "wrong_product",
    "message" => "License key is for a different product (XCOM required)",
  ]);
  exit;
}

// Optional: activate (increments timesActivated) after validation succeeds.
// Important: validate first to avoid consuming activations for the wrong product.
if ($action === 'activate') {
  $remaining = extract_int_field($validateParsed, 'remainingActivations');
  if ($remaining !== null && $remaining <= 0) {
    http_response_code(401);
    echo json_encode([
      "success" => false,
      "reason" => "activation_limit",
      "message" => "Activation limit reached for this license key",
    ]);
    exit;
  }

  $activateParsed = lm_get_license_data_or_exit($apiBase, 'activate', $licenseKey, $consumerKey, $consumerSecret);
  // Some LMFWC activate responses omit productId. We already validated the product above,
  // so only enforce this check when the field is actually present.
  $activateProductId = extract_product_id_from_validate($activateParsed);
  if ($activateProductId !== '' && !in_array($activateProductId, $allowedProductIds, true)) {
    http_response_code(401);
    echo json_encode([
      "success" => false,
      "reason" => "wrong_product",
      "message" => "License key is for a different product (XCOM required)",
    ]);
    exit;
  }
}

echo json_encode(["success" => true]);
