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

function extract_product_id_from_validate($parsed) {
  if (!is_array($parsed)) return '';

  if (isset($parsed['data']) && is_array($parsed['data'])) {
    $d = $parsed['data'];
    if (isset($d['productId'])) return trim(strval($d['productId']));
    if (isset($d['product_id'])) return trim(strval($d['product_id']));
  }

  if (isset($parsed['productId'])) return trim(strval($parsed['productId']));
  if (isset($parsed['product_id'])) return trim(strval($parsed['product_id']));

  return '';
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

function lm_get_license_data_or_exit($apiBase, $endpoint, $licenseKey, $consumerKey, $consumerSecret) {
  $url = $apiBase . '/licenses/' . $endpoint . '/' . rawurlencode($licenseKey);

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

  $tch = curl_init($testUrl);
  curl_setopt($tch, CURLOPT_RETURNTRANSFER, true);
  curl_setopt($tch, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
  curl_setopt($tch, CURLOPT_USERPWD, $consumerKey . ':' . $consumerSecret);
  curl_setopt($tch, CURLOPT_TIMEOUT, 20);
  curl_setopt($tch, CURLOPT_HEADER, false);

  $tBody = curl_exec($tch);
  $tErr = curl_error($tch);
  $tStatus = curl_getinfo($tch, CURLINFO_HTTP_CODE);
  curl_close($tch);

  if ($tBody === false) {
    http_response_code(502);
    echo json_encode(["success" => false, "reason" => "upstream_unreachable", "message" => "Store request failed: " . $tErr]);
    exit;
  }

  $snippet = substr(str_replace(["\r", "\n"], ' ', $tBody), 0, 260);
  echo json_encode([
    "success" => ($tStatus >= 200 && $tStatus < 300),
    "mode" => "selftest",
    "store_status" => $tStatus,
    "body_snippet" => $snippet,
  ]);
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
  $activateProductId = extract_product_id_from_validate($activateParsed);
  if ($activateProductId === '' || !in_array($activateProductId, $allowedProductIds, true)) {
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
