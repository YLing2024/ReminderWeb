import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ThemeController } from './components/ThemeController';
import HomePage from './pages/HomePage';
import { useReminderStore } from './store/useReminderStore';

const EditPage = lazy(() => import('./pages/EditPage'));
const DetailPage = lazy(() => import('./pages/DetailPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));

export default function App() {
  const loaded = useReminderStore((state) => state.loaded);
  const hydrate = useReminderStore((state) => state.hydrate);

  useEffect(() => {
    if (!loaded) void hydrate();
  }, [loaded, hydrate]);

  return (
    <Suspense fallback={<div style={{ padding: 24, textAlign: 'center' }}>正在载入…</div>}>
      <ThemeController />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/reminder/new" element={<EditPage />} />
        <Route path="/reminder/:id/edit" element={<EditPage />} />
        <Route path="/reminder/:id" element={<DetailPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
