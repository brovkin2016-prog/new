import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

interface Project { id: string; name: string; domain: string; targetUrl?: string; }

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');

  const load = () => api.get<Project[]>('/projects').then(setItems);
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !domain) return;
    await api.post('/projects', { name, domain, targetUrl: `https://${domain}/`, regionCodes: [213] });
    setName(''); setDomain('');
    load();
  }

  return (
    <>
      <h2>Проекты</h2>
      <div className="card">
        <form className="row" onSubmit={create}>
          <input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="домен (example.ru)" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <button type="submit">Добавить</button>
        </form>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Название</th><th>Домен</th><th></th></tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/projects/${p.id}`}>{p.name}</Link></td>
                <td className="muted">{p.domain}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="ghost" onClick={async () => { await api.del(`/projects/${p.id}`); load(); }}>Удалить</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={3} className="muted">Нет проектов</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
