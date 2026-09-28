import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api/client';

interface Summary {
  projects: number;
  tasks: Record<string, number>;
  runs: Record<string, number>;
  errors: number;
  avgDurationMs: number | null;
  recentRuns: any[];
}

export default function Dashboard() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<Summary>('/dashboard/summary').then(setS).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="card">Ошибка: {err}</div>;
  if (!s) return <div className="muted">Загрузка…</div>;

  const runData = Object.entries(s.runs).map(([status, count]) => ({ status, count }));
  const totalRuns = Object.values(s.runs).reduce((a, b) => a + b, 0);

  return (
    <>
      <h2>Дашборд</h2>
      <div className="grid">
        <div className="stat"><div className="n">{s.projects}</div><div className="l">Проектов</div></div>
        <div className="stat"><div className="n">{s.tasks.active ?? 0}</div><div className="l">Активных задач</div></div>
        <div className="stat"><div className="n">{totalRuns}</div><div className="l">Запусков всего</div></div>
        <div className="stat"><div className="n" style={{ color: 'var(--err)' }}>{s.errors}</div><div className="l">Ошибок</div></div>
        <div className="stat"><div className="n">{s.avgDurationMs ? Math.round(s.avgDurationMs / 1000) + 'с' : '—'}</div><div className="l">Ср. время</div></div>
      </div>

      <div className="card">
        <h3>Запуски по статусам</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={runData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262b36" />
            <XAxis dataKey="status" stroke="#8a93a6" />
            <YAxis stroke="#8a93a6" allowDecimals={false} />
            <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #262b36' }} />
            <Bar dataKey="count" fill="#4c8dff" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h3>Последние запуски</h3>
        <table>
          <thead><tr><th>Задача</th><th>Тип</th><th>Статус</th><th>Создан</th></tr></thead>
          <tbody>
            {s.recentRuns.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/tasks/${r.taskId}`}>{r.task?.name}</Link></td>
                <td className="muted">{r.task?.type}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td className="muted">{new Date(r.createdAt).toLocaleString('ru')}</td>
              </tr>
            ))}
            {!s.recentRuns.length && <tr><td colSpan={4} className="muted">Пока нет запусков</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
