export function renderLoginPage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Whitehall Admin Login</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f6f7fb; }
    .card { background: #fff; padding: 24px; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); width: 320px; }
    h1 { margin: 0 0 12px; font-size: 20px; }
    label { display: block; margin: 12px 0 4px; font-size: 13px; color: #444; }
    input { width: 100%; padding: 10px; border: 1px solid #d8dbe4; border-radius: 6px; font-size: 14px; }
    button { margin-top: 16px; width: 100%; padding: 10px; background: #111827; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    .error { color: #b91c1c; margin-top: 10px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin Login</h1>
    <form id="loginForm">
      <label>Email</label>
      <input name="email" type="email" required />
      <label>Password</label>
      <input name="password" type="password" required />
      <button type="submit">Login</button>
      <div id="error" class="error" style="display:none;"></div>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const errorBox = document.getElementById('error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      const formData = new FormData(form);
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email: formData.get('email'),
          password: formData.get('password')
        })
      });
      if (res.ok) {
        window.location.href = '/admin';
      } else {
        const data = await res.json().catch(() => ({}));
        errorBox.textContent = data.error || 'Login failed';
        errorBox.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}
