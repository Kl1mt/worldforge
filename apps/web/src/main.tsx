import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ReloadBoundary } from './notes/ReloadBoundary';
import './styles/base.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    {/* Ticket F.4: the last line of defence against a blank page (inner one: the Shell). */}
    <ReloadBoundary>
      <App />
    </ReloadBoundary>
  </StrictMode>,
);
