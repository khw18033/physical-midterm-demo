import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MissionDebugger } from './main.tsx';
import './style.css';

createRoot(document.getElementById('root')!).render(<StrictMode><main className="standalone"><MissionDebugger /></main></StrictMode>);
