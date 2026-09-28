import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getToken, setToken } from './api/client';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import Project from './pages/Project';
import TaskDetail from './pages/TaskDetail';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>pf.sites-s.ru</h1>
        <NavLink to="/" end>Дашборд</NavLink>
        <NavLink to="/projects">Проекты</NavLink>
        <div style={{ flex: 1 }} />
        <a onClick={() => { setToken(null); location.hash = '#/login'; }} style={{ cursor: 'pointer' }}>Выход</a>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}

export default function App() {
  const loc = useLocation();
  const authed = !!getToken();
  if (!authed && loc.pathname !== '/login') return <Navigate to="/login" replace />;

  if (loc.pathname === '/login') return <Routes><Route path="/login" element={<Login />} /></Routes>;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<Project />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
