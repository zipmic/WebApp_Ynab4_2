<?php
/**
 * Budget Reborn — hosting capability check.
 * Upload this ONE file to your web space, open it once in the browser, read the result, then DELETE it.
 * It tells you whether your host can run Budget Reborn (which needs Node.js) and what it offers instead.
 * It shows no secrets and changes nothing.
 */
header('Content-Type: text/plain; charset=utf-8');
header('X-Robots-Tag: noindex');
function yes($b) { return $b ? 'YES' : 'no'; }
$disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
$canExec = function_exists('shell_exec') && !in_array('shell_exec', $disabled, true);
$node = $canExec ? trim((string) @shell_exec('node -v 2>/dev/null')) : '';
$npm = $canExec ? trim((string) @shell_exec('npm -v 2>/dev/null')) : '';
$docroot = $_SERVER['DOCUMENT_ROOT'] ?? '';
$above = $docroot ? dirname($docroot) : '';
echo "Budget Reborn hosting check\n===========================\n\n";
echo "PHP version:                 " . PHP_VERSION . "\n";
echo "Server software:             " . ($_SERVER['SERVER_SOFTWARE'] ?? 'unknown') . "\n";
echo "HTTPS in use right now:      " . yes(!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') . "\n";
echo "Can run shell commands:      " . yes($canExec) . "\n";
echo "Node.js available:           " . ($node !== '' ? "YES ($node)" : 'no (or not detectable from PHP)') . "\n";
echo "npm available:               " . ($npm !== '' ? "YES ($npm)" : 'no (or not detectable from PHP)') . "\n";
echo "Phusion Passenger (Node apps via control panel): " . yes(isset($_SERVER['PASSENGER_APP_ENV']) || getenv('PASSENGER_APP_ENV') !== false || stripos($_SERVER['SERVER_SOFTWARE'] ?? '', 'passenger') !== false) . "\n";
echo "PHP SQLite (pdo_sqlite):     " . yes(extension_loaded('pdo_sqlite')) . "\n";
echo "PHP MySQL (pdo_mysql):       " . yes(extension_loaded('pdo_mysql')) . "\n";
echo "PHP Argon2id hashing:        " . yes(defined('PASSWORD_ARGON2ID')) . "\n";
echo "Folder above web root writable (for private data): " . yes($above && is_writable($above)) . "\n\n";
echo "What this means\n---------------\n";
if ($node !== '' && version_compare(ltrim($node, 'v'), '20.11.0', '>=')) {
    echo "Your host has a recent Node.js. Budget Reborn can run here if the host lets you keep a Node process\nrunning (look for \"Node.js app\", \"Passenger\" or \"Application manager\" in the control panel). See docs/DEPLOYMENT.md.\n";
} elseif ($node !== '') {
    echo "Node.js is present but older than 20.11. Ask the host for Node 20 or newer, or use another option in docs/DEPLOYMENT.md.\n";
} else {
    echo "No Node.js was detected. Classic PHP-only web space cannot run Budget Reborn's backend.\nCheck your control panel for a Node.js feature (it is often not visible from PHP). If there is none, use one of the\nother options in docs/DEPLOYMENT.md: a small VPS, a Raspberry Pi / NAS / home PC, optionally reachable only through a VPN.\n";
}
echo "\nIMPORTANT: delete this file from the server now.\n";
