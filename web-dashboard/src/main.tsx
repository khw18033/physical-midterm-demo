import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './views/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root 없음');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
