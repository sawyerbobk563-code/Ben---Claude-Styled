/**
 * Ben AI — Service Worker v4
 * - App shell caching: page, CSS, fonts all served from cache offline
 * - Cache-first for shell files; network-first with cache fallback for everything else
 * - IndexedDB-scheduled reminders fire when SW wakes
 * - Background Sync fires overdue reminders when connectivity returns
 * - Periodic Sync checks every ~60s (Chrome/Android)
 */

const SW_VERSION     = 'ben-sw-v4';
const CACHE_NAME     = 'ben-shell-v4';
const REMINDER_STORE = 'ben_scheduled_reminders';
const DB_NAME        = 'BenSW';
const DB_VER         = 1;

// Core app shell — everything needed to render the UI offline
const SHELL_FILES = [
  './',
  './ben.html',
  './sw.js',
];

// Hosts whose requests should NEVER be cached (API calls, cloud worker)
const NEVER_CACHE_HOSTS = [
  'api.groq.com',
  'api.mistral.ai',
  'workers.dev',       // Cloudflare workers (cloud sync)
  'cdn.jsdelivr.net',  // KaTeX — too large; load from network
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnfonts.com',
];

function shouldSkipCache(url) {
  return NEVER_CACHE_HOSTS.some(h => url.hostname.includes(h));
}

let _lastFetchCheck = 0;

// ── Install: cache app shell ───────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(SHELL_FILES.map(f =>
        cache.add(f).catch(e => console.warn('[SW] Failed to cache', f, e))
      ))
    )
  );
});

// ── Activate: drop old caches ──────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
    ])
  );
});

// ── Fetch strategy ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POST/etc

  const url = new URL(req.url);

  // Skip API calls and external services — let them fail naturally when offline
  if (shouldSkipCache(url)) return;

  // Same-origin requests: cache-first, update in background
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        // Always try to refresh the cache in background
        const networkFetch = fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => null);

        // Return cached immediately if available; otherwise wait for network
        if (cached) {
          // Background refresh, return cache now
          networkFetch.catch(() => {});
          return cached;
        }
        // No cache — wait for network, or return offline page
        return networkFetch.then(res => res || offlineFallback());
      })
    );
    // Debounced reminder check on any same-origin fetch
    const now = Date.now();
    if (now - _lastFetchCheck > 30000) {
      _lastFetchCheck = now;
      checkAndFireScheduled().catch(() => {});
    }
    return;
  }

  // Cross-origin (fonts, CDN): network with cache fallback
  event.respondWith(
    caches.match(req).then(cached => {
      return fetch(req).then(res => {
        if (res.ok) {
          caches.open(CACHE_NAME).then(c => c.put(req, res.clone()));
        }
        return res;
      }).catch(() => cached || new Response('', { status: 503 }));
    })
  );
});

// Minimal offline fallback — returns the cached ben.html if available
async function offlineFallback() {
  const cached = await caches.match('./ben.html') || await caches.match('./');
  if (cached) return cached;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>You're offline</h2>
      <p>Ben AI couldn't load. Please check your connection and try again.</p>
      <button onclick="location.reload()">Retry</button>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}

// ── Push (server-side use) ─────────────────────────────────────
self.addEventListener('push', event => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch(e) {
    p = { title: 'Ben', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(Promise.all([
    self.registration.showNotification(p.title || 'Ben Reminder', {
      body: p.body || p.message || '', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: p.tag || 'ben-push', renotify: true,
      data: { url: p.url || './' }, vibrate: [200, 100, 200],
    }),
    checkAndFireScheduled()
  ]));
});

// ── Notification click ─────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// ── Messages from main page ────────────────────────────────────
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};
  if (type === 'SCHEDULE_REMINDER') event.waitUntil(storeReminder(payload));
  if (type === 'CANCEL_REMINDER')   event.waitUntil(deleteReminder(payload.id));
  if (type === 'CHECK_REMINDERS')   event.waitUntil(checkAndFireScheduled());
});

// ── Background Sync: fires when connectivity returns ──────────
self.addEventListener('sync', event => {
  if (event.tag === 'check-reminders') event.waitUntil(checkAndFireScheduled());
});

// ── Periodic Background Sync (Chrome/Android ~60s) ────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-reminders') event.waitUntil(checkAndFireScheduled());
});

// ── IndexedDB ─────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(REMINDER_STORE)) {
        const store = db.createObjectStore(REMINDER_STORE, { keyPath: 'id' });
        store.createIndex('fireAt', 'fireAt');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function storeReminder(r) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMINDER_STORE, 'readwrite');
    tx.objectStore(REMINDER_STORE).put(r);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function deleteReminder(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMINDER_STORE, 'readwrite');
    tx.objectStore(REMINDER_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function getAllReminders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REMINDER_STORE, 'readonly');
    const req = tx.objectStore(REMINDER_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Fire all due reminders ─────────────────────────────────────
async function checkAndFireScheduled() {
  try {
    const all = await getAllReminders();
    const due = all.filter(r => r.fireAt <= Date.now());
    if (!due.length) return;
    await Promise.all(due.map(async r => {
      await self.registration.showNotification(r.title || 'Ben Reminder', {
        body: r.message || '', icon: '/icon-192.png', badge: '/icon-192.png',
        tag: r.id, renotify: true, data: { url: './' }, vibrate: [200, 100, 200],
      });
      if (r.recurring && r.recurDayOfWeek !== undefined && r.recurTime) {
        const [hh, mm] = r.recurTime.split(':').map(Number);
        const next = new Date(r.fireAt);
        next.setDate(next.getDate() + 7);
        next.setHours(hh, mm, 0, 0);
        await storeReminder({ ...r, fireAt: next.getTime() });
      } else {
        await deleteReminder(r.id);
      }
    }));
  } catch(e) { /* SW must not crash */ }
}
