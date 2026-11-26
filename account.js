const form = document.getElementById('change');
const statusText = document.getElementById('status');
async function loadAccount() {
  const response = await fetch('/api/account');
  if (response.status === 401) return location.replace('/login');
  const account = await response.json();
  document.getElementById('name').textContent = account.username;
  form.hidden = account.managed;
  if (account.managed) statusText.textContent = '운영자 비밀번호는 서버 환경 변수에서 관리합니다.';
}
loadAccount().catch(() => { statusText.textContent = '계정을 불러오지 못했습니다.'; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const response = await fetch('/api/account/password', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if (response.ok || response.status === 401) return location.replace('/login');
    statusText.textContent = '현재 비밀번호를 확인해 주세요.';
  } catch { statusText.textContent = '서버 연결을 확인해 주세요.'; }
});
