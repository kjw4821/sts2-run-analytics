const signup = location.pathname === '/signup';
const field = id => document.getElementById(id);
if (signup) {
  document.title = '회원가입 | Spire Analytics';
  field('title').textContent = field('submit').textContent = '회원가입';
  field('password').autocomplete = 'new-password';
  field('confirm-label').hidden = false;
  field('confirm').required = true;
  field('notice').textContent = '아이디는 한글·영문·숫자·밑줄·하이픈 3~32자, 비밀번호는 12자 이상입니다.';
  field('switch').href = '/login';
  field('switch').textContent = '로그인으로 돌아가기';
}
field('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = field('password').value;
  if (signup && password !== field('confirm').value) {
    field('notice').textContent = '비밀번호 확인 값이 다릅니다.';
    return;
  }
  field('submit').disabled = true;
  try {
    const response = await fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username:field('username').value, password})});
    if (response.ok) location.replace('/');
    else field('notice').textContent = (await response.json()).message;
  } catch {
    field('notice').textContent = '서버 연결을 확인해 주세요.';
  } finally { field('submit').disabled = false; }
});
