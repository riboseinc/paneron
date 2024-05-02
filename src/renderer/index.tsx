import { debounce } from 'throttle-debounce';

import React from 'react';
import ReactDOM from 'react-dom';

import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!jsondiffpatch/dist/formatters-styles/annotated.css';
import '!style-loader!css-loader!jsondiffpatch/dist/formatters-styles/html.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!@blueprintjs/popover2/lib/css/blueprint-popover2.css';
import '!style-loader!css-loader!react-resizable/css/styles.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';

import { BP4_RESET_CSS } from '@riboseinc/paneron-extension-kit/util';

import ErrorBoundary from '@riboseinc/paneron-extension-kit/widgets/ErrorBoundary';
import MainWindow from './MainWindow/index';

import { openExternalURL, colorSchemeUpdated } from 'common';


// FIXME: Not sustainable and can mess up CSP
const style = document.createElement("style");
style.textContent = BP4_RESET_CSS;
document.head.appendChild(style);


// Set color scheme

function applyColorScheme(opts: { colorSchemeName: string }) {
  if (opts.colorSchemeName === 'dark') {
    document.body.classList.add('bp4-dark');
    document.body.style.backgroundColor = 'black';
  } else {
    document.body.classList.remove('bp4-dark');
    document.body.style.backgroundColor = 'white';
  }
}

/** Params passed to the window from main via GET query string. */
const searchParams = new URLSearchParams(window.location.search);
const colorScheme = searchParams.get('colorScheme');
if (colorScheme) { applyColorScheme({ colorSchemeName: colorScheme }); }

/** The root element that’s supposed to be guaranteed by electron-webpack. */
const containerEl: HTMLElement | null = document.getElementById('app');
if (containerEl === null) {
  throw new Error("Missing app container");
}

// Do the rest.

const applyColorSchemeDebounced = debounce(1000, applyColorScheme);
colorSchemeUpdated.renderer!.handle(applyColorSchemeDebounced);

/**
 * Processes any click; if clicked element is a link with HTTP(S) protocol,
 * then handle it using default browser via `openExternalURL`;
 * otherwise don’t handle (leave to default handling).
 */
function handleLinkClick(evt: MouseEvent) {
  if ((evt.target as Element | null)?.tagName === 'A') {
    const linkHref = (evt.target as Element | null)?.getAttribute?.('href')?.toLowerCase().trim() || '';
    if (linkHref !== '' && linkHref.startsWith('http')) {
      evt.preventDefault();
      evt.stopPropagation();
      openExternalURL.renderer!.trigger({ url: linkHref });
      return 'overriding click';
    }
  }
  // This should preserve the default <a> handling
  return;
}

window.addEventListener('click', handleLinkClick);

ReactDOM.render(
  <ErrorBoundary viewName="Main window">
    <MainWindow />
  </ErrorBoundary>,
  containerEl);


import 'common';
import 'repositories/ipc';
import 'datasets/ipc';
