import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';

type Tab = 'keywords' | 'tasks' | 'semantics';

export default function Project() {
  const { id } = useParams();
  const [tab, setTab] = useState<Tab>('keywords');
  const [project, setProject] = useState<any>(null);

  useEffect(() => { api.get(`/projects/${id}`).then(setProject); }, [id]);

  return (
    <>
      <h2>{project?.name ?? 'Проект'} <span className="muted">{project?.domain}</span></h2>
      <div className="row" style={{ marginBottom: 16 }}>
        {(['keywords', 'tasks', 'semantics'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? '' : 'ghost'} onClick={() => setTab(t)}>
            {t === 'keywords' ? 'Ключи' : t === 'tasks' ? 'Задачи' : 'Семантика'}
          </button>
        ))}
      </div>
      {tab === 'keywords' && <Keywords projectId={id!} />}
      {tab === 'tasks' && <Tasks projectId={id!} />}
      {tab === 'semantics' && <Semantics projectId={id!} />}
    </>
  );
}

function Keywords({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [phrase, setPhrase] = useState('');
  const [bulk, setBulk] = useState('');
  const load = () => api.get<any[]>(`/projects/${projectId}/keywords`).then(setItems);
  useEffect(() => { load(); }, [projectId]);

  return (
    <>
      <div className="card">
        <div className="row">
          <input placeholder="Ключевая фраза" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <button onClick={async () => { if (phrase) { await api.post(`/projects/${projectId}/keywords`, { phrase, regionCode: 213 }); setPhrase(''); load(); } }}>+ Ключ</button>
        </div>
        <textarea placeholder="Массово: по фразе на строку" rows={4} style={{ marginTop: 8 }} value={bulk} onChange={(e) => setBulk(e.target.value)} />
        <button style={{ marginTop: 8 }} onClick={async () => {
          const phrases = bulk.split('\n').map((s) => s.trim()).filter(Boolean);
          if (phrases.length) { await api.post(`/projects/${projectId}/keywords/bulk`, { phrases, regionCode: 213 }); setBulk(''); load(); }
        }}>Добавить списком</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Фраза</th><th>Регион</th><th>Частотность</th><th></th></tr></thead>
          <tbody>
            {items.map((k) => (
              <tr key={k.id}>
                <td>{k.phrase}</td><td className="muted">{k.regionCode ?? '—'}</td><td className="muted">{k.frequency ?? '—'}</td>
                <td style={{ textAlign: 'right' }}><button className="ghost" onClick={async () => { await api.del(`/keywords/${k.id}`); load(); }}>✕</button></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={4} className="muted">Нет ключей</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tasks({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [type, setType] = useState('positions');
  const [name, setName] = useState('');
  const [cron, setCron] = useState('');
  const load = () => api.get<any[]>(`/projects/${projectId}/tasks`).then(setItems);
  useEffect(() => { load(); }, [projectId]);

  const act = async (id: string, action: string) => { await api.post(`/tasks/${id}/${action}`); load(); };

  return (
    <>
      <div className="card">
        <div className="row">
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 160 }}>
            <option value="positions">Позиции</option>
            <option value="audit">Аудит</option>
            <option value="semantics">Семантика</option>
            <option value="competitors">Конкуренты</option>
          </select>
          <input placeholder="Название задачи" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="cron (опц.) 0 3 * * *" value={cron} onChange={(e) => setCron(e.target.value)} style={{ width: 160 }} />
          <button onClick={async () => { if (name) { await api.post(`/projects/${projectId}/tasks`, { type, name, cron: cron || undefined }); setName(''); setCron(''); load(); } }}>Создать</button>
        </div>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Задача</th><th>Тип</th><th>Статус</th><th>Cron</th><th>Действия</th></tr></thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/tasks/${t.id}`}>{t.name}</Link></td>
                <td className="muted">{t.type}</td>
                <td><span className={`badge ${t.status === 'active' ? 'success' : 'queued'}`}>{t.status}</span></td>
                <td className="muted">{t.cron ?? '—'}</td>
                <td className="row">
                  <button onClick={() => act(t.id, 'run')}>▶ Запуск</button>
                  {t.status === 'active'
                    ? <button className="ghost" onClick={() => act(t.id, 'pause')}>Пауза</button>
                    : <button className="ghost" onClick={() => act(t.id, 'resume')}>Возобновить</button>}
                  <button className="ghost" onClick={() => act(t.id, 'stop')}>Стоп</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={5} className="muted">Нет задач</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Semantics({ projectId }: { projectId: string }) {
  const [core, setCore] = useState<any>(null);
  const [markers, setMarkers] = useState('');
  const load = () => api.get(`/projects/${projectId}/semantics/core`).then(setCore);
  useEffect(() => { load(); }, [projectId]);

  return (
    <>
      <div className="card">
        <div className="row">
          <input placeholder="Маркерные запросы через запятую" value={markers} onChange={(e) => setMarkers(e.target.value)} />
          <button onClick={async () => {
            const arr = markers.split(',').map((s) => s.trim()).filter(Boolean);
            if (arr.length) { await api.post(`/projects/${projectId}/semantics/expand`, { markers: arr, regionCode: 213 }); setMarkers(''); alert('Ядро расширено. Запустите задачу semantics для кластеризации.'); }
          }}>Расширить ядро</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>Кластеризация выполняется задачей типа «Семантика».</p>
      </div>
      <div className="card">
        <h3>Кластеры</h3>
        <table>
          <thead><tr><th>Кластер</th><th>Интент</th><th>Объём</th><th>Потенциал</th><th>Приоритет</th><th>Пробел</th></tr></thead>
          <tbody>
            {(core?.clusters ?? []).map((c: any) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="muted">{c.intent}</td>
                <td>{c.volume}</td>
                <td>{c.potentialTraffic}</td>
                <td>{Math.round(c.priority * 1000) / 1000}</td>
                <td>{c.isGap ? <span className="badge failed">пробел</span> : '—'}</td>
              </tr>
            ))}
            {!(core?.clusters ?? []).length && <tr><td colSpan={6} className="muted">Ядро пусто</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
