import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';

export default function TaskDetail() {
  const { id } = useParams();
  const [task, setTask] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState<string>('');
  const [report, setReport] = useState<any>(null);

  const loadRuns = () => api.get<any[]>(`/tasks/${id}/runs`).then((r) => {
    setRuns(r);
    if (r.length && !runId) setRunId(r[0].id);
  });
  useEffect(() => { api.get(`/tasks/${id}`).then(setTask); loadRuns(); }, [id]);
  useEffect(() => { if (runId) api.get(`/runs/${runId}/report`).then(setReport).catch(() => setReport(null)); }, [runId]);

  const rerun = async () => { await api.post(`/tasks/${id}/runs/${runId}/rerun`); loadRuns(); };

  return (
    <>
      <h2>{task?.name} <span className="muted">{task?.type}</span></h2>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <button onClick={async () => { await api.post(`/tasks/${id}/run`); setTimeout(loadRuns, 500); }}>▶ Запустить</button>
            <button className="ghost" onClick={rerun} disabled={!runId}>Повторить запуск</button>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => api.download(runId, 'csv')} disabled={!runId}>CSV</button>
            <button className="ghost" onClick={() => api.download(runId, 'xlsx')} disabled={!runId}>XLSX</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>История запусков</h3>
        <table>
          <thead><tr><th>Статус</th><th>Начат</th><th>Длительность</th><th>Итог</th><th></th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer', background: r.id === runId ? '#20242e' : undefined }} onClick={() => setRunId(r.id)}>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString('ru') : '—'}</td>
                <td className="muted">{r.startedAt && r.finishedAt ? Math.round((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000) + 'с' : '—'}</td>
                <td className="muted">{JSON.stringify(r.stats).slice(0, 60)}</td>
                <td>{r.error && <span style={{ color: 'var(--err)' }}>{r.error.slice(0, 40)}</span>}</td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={5} className="muted">Нет запусков</td></tr>}
          </tbody>
        </table>
      </div>

      {report && <ReportView type={task?.type} data={report.data} runId={runId} />}
    </>
  );
}

function ReportView({ type, data, runId }: { type: string; data: any; runId: string }) {
  const [pages, setPages] = useState<any[]>([]);
  const [broken, setBroken] = useState<any[]>([]);
  useEffect(() => {
    if (type === 'audit' && runId) {
      api.get<any[]>(`/runs/${runId}/audit/pages`).then(setPages);
      api.get<any[]>(`/runs/${runId}/audit/broken-links`).then(setBroken);
    }
  }, [type, runId]);

  if (type === 'positions') return (
    <div className="card">
      <h3>Позиции</h3>
      <div className="grid" style={{ marginBottom: 12 }}>
        <Stat n={data.top3} l="ТОП-3" /><Stat n={data.top10} l="ТОП-10" /><Stat n={data.top30} l="ТОП-30" />
        <Stat n={data.notFound} l="Не найдено" /><Stat n={data.avgPosition ?? '—'} l="Ср. позиция" />
      </div>
      <table>
        <thead><tr><th>Фраза</th><th>Регион</th><th>Позиция</th><th>URL</th></tr></thead>
        <tbody>{(data.items ?? []).map((r: any, i: number) => (
          <tr key={i}><td>{r.phrase}</td><td className="muted">{r.region}</td><td>{r.position ?? '—'}</td><td className="muted">{r.url}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );

  if (type === 'audit') return (
    <>
      <div className="card">
        <h3>Аудит</h3>
        <div className="grid">
          <Stat n={data.pages} l="Страниц" /><Stat n={data.brokenLinks} l="Битых ссылок" />
          <Stat n={data.pagesWithIssues} l="С проблемами" /><Stat n={data.avgLcpMs ? data.avgLcpMs + 'мс' : '—'} l="Ср. LCP" />
        </div>
        {!!(data.technicalIssues ?? []).length && <p className="muted">Тех. ошибки: {data.technicalIssues.join(', ')}</p>}
      </div>
      <div className="card">
        <h3>Страницы</h3>
        <table>
          <thead><tr><th>URL</th><th>Код</th><th>Ответ</th><th>LCP</th><th>Проблемы</th></tr></thead>
          <tbody>{pages.map((p) => (
            <tr key={p.id}><td className="muted">{p.url}</td><td>{p.statusCode}</td><td>{p.responseMs ?? '—'}мс</td><td>{p.lcpMs ?? '—'}</td><td className="muted">{(p.issues ?? []).join(', ')}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {!!broken.length && <div className="card">
        <h3>Битые ссылки</h3>
        <table><thead><tr><th>Со страницы</th><th>Ссылка</th><th>Код</th></tr></thead>
          <tbody>{broken.map((b) => (<tr key={b.id}><td className="muted">{b.fromUrl}</td><td className="muted">{b.toUrl}</td><td style={{ color: 'var(--err)' }}>{b.statusCode}</td></tr>))}</tbody>
        </table>
      </div>}
    </>
  );

  if (type === 'semantics') return (
    <div className="card">
      <h3>Семантика</h3>
      <div className="grid">
        <Stat n={data.clusters} l="Кластеров" /><Stat n={data.totalVolume} l="Суммарный объём" />
        <Stat n={data.totalPotential} l="Потенциал трафика" /><Stat n={data.gaps} l="Пробелов" />
      </div>
    </div>
  );

  if (type === 'competitors') return (
    <div className="card">
      <h3>Конкуренты</h3>
      <table><thead><tr><th>Домен</th><th>Кластеров</th><th>Видимость</th><th>Трафик</th></tr></thead>
        <tbody>{(data.topCompetitors ?? []).map((c: any, i: number) => (
          <tr key={i}><td>{c.domain}</td><td>{c.clusters}</td><td className="muted">{c.visibility ?? '—'}</td><td className="muted">{c.traffic ?? '—'}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );

  return null;
}

function Stat({ n, l }: { n: any; l: string }) {
  return <div className="stat"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
