import { render } from 'preact';
import { load } from 'lattice-swap-driver';
import { App } from './app';
import { buildConfig } from './config';
import { bounded } from './format';
import './style.css';

const root = document.getElementById('app')!;
load().then(
  () => render(<App config={buildConfig()} />, root),
  (e: Error) => {
    root.textContent = `This browser could not load the swap engine: ${bounded(e.message)}`;
  },
);
