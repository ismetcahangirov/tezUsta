/**
 * The page the cancel link in the old address's notice opens (#515,
 * ADR-0074 § 2).
 *
 * **Opening it cancels nothing.** Mail providers and link scanners fetch links
 * in a message before anyone reads it; if a `GET` cancelled, every recovery
 * would be cancelled by the old address's own spam filter, including the
 * recoveries of owners who really have lost it. The page asks, and only the
 * button's `POST` cancels.
 *
 * The token is in the URL's fragment, which a browser never sends, so it is in
 * no access log; the page's one script reads it and posts it. The script and
 * style carry a per-response nonce, and the policy allows nothing else.
 *
 * **Placeholder wording and layout**: both are the owner's (CLAUDE.md § 17).
 */
export function renderCancelPage(nonce: string): string {
  return `<!doctype html>
<html lang="az">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TezUsta — bərpa sorğusunun ləğvi</title>
<style nonce="${nonce}">
body{font-family:system-ui,sans-serif;margin:0;padding:24px;max-width:480px;color:#111;background:#fff}
button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#1877F2;color:#fff}
button[disabled]{opacity:.5}
</style>
</head>
<body>
<h1>Bərpa sorğusunu ləğv edin</h1>
<p id="lead">Hesabınızın e-poçt ünvanının dəyişdirilməsini siz istəməmisinizsə, sorğunu ləğv edin. Hesabınız əvvəlki ünvanla qalacaq.</p>
<button id="cancel" type="button">Sorğunu ləğv et</button>
<p id="result" role="status"></p>
<script nonce="${nonce}">
(function () {
  var token = location.hash.slice(1);
  var button = document.getElementById('cancel');
  var result = document.getElementById('result');
  if (!token) {
    button.disabled = true;
    result.textContent = 'Keçid natamamdır. Məktubdakı keçidi bütöv açın.';
    return;
  }
  button.addEventListener('click', function () {
    button.disabled = true;
    fetch('cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (response) {
      if (response.status === 204) {
        history.replaceState(null, '', location.pathname);
        result.textContent = 'Sorğu artıq qüvvədə deyil. Hesabınız əvvəlki ünvanla qalır.';
      } else {
        button.disabled = false;
        result.textContent = 'Alınmadı. Bir az sonra yenidən cəhd edin.';
      }
    }, function () {
      button.disabled = false;
      result.textContent = 'Alınmadı. Bir az sonra yenidən cəhd edin.';
    });
  });
})();
</script>
</body>
</html>
`;
}

/** Nothing loads but the page's own nonce'd script and style, and the one same-origin `POST`. */
export function cancelPagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
