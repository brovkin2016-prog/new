import { useState } from 'react';
import { api, setToken } from '../api/client';

export default function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const res = await api.post<{ accessToken: string }>(`/auth/${mode}`, { email, password });
      setToken(res.accessToken);
      location.hash = '#/';
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="center">
      <form className="auth card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Вход' : 'Регистрация'}</h2>
        <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Пароль (мин. 8)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div style={{ color: 'var(--err)' }}>{err}</div>}
        <button type="submit">{mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
        <a style={{ cursor: 'pointer' }} onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Создать аккаунт' : 'У меня уже есть аккаунт'}
        </a>
      </form>
    </div>
  );
}
