const express = require('express');
const { randomBytes, createHash, timingSafeEqual, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const lifetime = 7 * 86400000;
const digest = text => createHash('sha256').update(text).digest();

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64);
  return salt + '.' + key.toString('hex');
}

function installAccounts(app, db, { publicUrl, username: ownerName, credentials }) {
  const cookie = { httpOnly: true, secure: Boolean(publicUrl), sameSite: 'lax', path: '/' };
  const name = publicUrl ? '__Host-spire' : 'spire';
  const tokenOf = req => (req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith(name + '='))?.slice(name.length + 1);
  const sql = (query, ...args) => db.account(query, args);
  const attempts = new Map();
  let active = 0;
  app.get('/styles.css', (req, res) => res.sendFile('styles.css', { root: __dirname }));
  app.get(['/login', '/signup'], (req, res) => res.sendFile('auth.html', { root: __dirname }));
  app.get('/auth.js', (req, res) => res.sendFile('auth.js', { root: __dirname }));
  app.post(['/login', '/signup'], express.json({ limit: '4kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password ||
        password.length > 1024) return res.status(400).json({ message: '아이디와 비밀번호를 확인해 주세요.' });
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const ip = publicUrl ? (req.get('x-forwarded-for') || '').split(',').pop().trim() || req.ip : req.ip;
    const entry = attempts.get(ip) || { count: 0, until: now + 600000 };
    if (entry.count >= 30 || active >= 6) return res.status(429).json({ message: '잠시 후 다시 시도해 주세요.' });
    entry.count++;
    attempts.set(ip, entry);
    active++;
    try {
      let userId;
      const owner = ownerName && username.toLowerCase() === ownerName.toLowerCase();
      if (req.path === '/signup') {
        if (!/^[가-힣a-zA-Z0-9_-]{3,32}$/u.test(username) || password.length < 12)
          return res.status(400).json({ message: '아이디는 한글·영문·숫자·밑줄·하이픈 3~32자, 비밀번호는 12자 이상으로 입력해 주세요.' });
        const user = !owner && await sql('INSERT INTO Users(username,password_hash) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING id', username, await passwordHash(password));
        if (!user) return res.status(409).json({ message: '이미 사용 중인 아이디입니다.' });
        userId = user.id;
      } else if (owner && credentials && timingSafeEqual(credentials, digest(username + ':' + password))) {
        userId = 1;
      } else {
        const user = await sql('SELECT id,password_hash FROM Users WHERE username = ?', username);
        const stored = user?.password_hash;
        const actual = await passwordHash(password, stored?.split('.')[0] || '00000000000000000000000000000000');
        if (!stored || owner || !timingSafeEqual(Buffer.from(actual), Buffer.from(stored)))
          return res.status(401).json({ message: '아이디 또는 비밀번호를 확인해 주세요.' });
        userId = user.id;
      }
      const token = randomBytes(32).toString('hex');
      await sql('DELETE FROM Sessions WHERE expires <= ?', now);
      await sql('INSERT INTO Sessions VALUES (?,?,?)', digest(token).toString('hex'), userId, now + lifetime);
      res.cookie(name, token, { ...cookie, maxAge: lifetime }).status(204).end();
    } finally { active--; }
  });
  app.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = tokenOf(req);
    const key = token && /^[a-f0-9]{64}$/.test(token) && digest(token).toString('hex');
    const session = key && await sql('SELECT user_id FROM Sessions WHERE token = ? AND expires > ?', key, Date.now());
    if (!session) return req.path.startsWith('/api/') ? res.status(401).json({message:'로그인이 필요합니다.'}) : res.redirect('/login');
    req.userId = session.user_id;
    if (req.method === 'POST' && req.path === '/logout') {
      await sql('DELETE FROM Sessions WHERE token = ?', key);
      return res.clearCookie(name, cookie).redirect(303, '/login');
    }
    next();
  });
  app.get('/account', (_req, res) => res.sendFile('account.html', {root: __dirname}));
  app.get('/api/account', async (req,res) => {
    const account = await sql('SELECT username FROM Users WHERE id = ?', req.userId);
    res.json({username: account.username || ownerName, managed: req.userId === 1});
  });
  app.get('/account.js', (_req,res) => res.sendFile('account.js', {root:__dirname}));
  app.post('/api/account/password', express.json({limit:'4kb'}), async (req,res) => {
    const {current, replacement} = req.body || {};
    if (req.userId === 1 || typeof current !== 'string' || typeof replacement !== 'string' ||
        replacement.length < 12 || replacement.length > 1024 || current.length > 1024) return res.sendStatus(400);
    const user = await sql('SELECT password_hash FROM Users WHERE id = ?', req.userId);
    const actual = await passwordHash(current, user.password_hash.split('.')[0]);
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(user.password_hash))) return res.sendStatus(403);
    if (!await db.changePassword(req.userId, actual, await passwordHash(replacement))) return res.sendStatus(409);
    res.clearCookie(name,cookie).status(204).end();
  });
}
module.exports = { installAccounts };
