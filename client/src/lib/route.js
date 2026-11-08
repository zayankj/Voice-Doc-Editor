import { useEffect, useState } from 'react';

// A tiny "hash router": the page name lives after the # in the address,
// e.g. http://localhost:5173/#/templates/nursing  ->  ['templates', 'nursing']
// The browser Back button works and a page refresh stays on the same page.
// No library needed.

export const DEFAULT_PAGE = 'summaries'; // the existing editor screen opens first, exactly like before

function readHash() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return parts.length ? parts : [DEFAULT_PAGE];
}

// Returns the current route as a list of parts and re-renders when it changes
export function useRoute() {
  const [parts, setParts] = useState(readHash);
  useEffect(() => {
    const onChange = () => setParts(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parts;
}

// Go to a page, e.g. go('templates/nursing')
export function go(path) {
  window.location.hash = `/${path}`;
}
