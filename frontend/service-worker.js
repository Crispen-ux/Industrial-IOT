const CACHE_NAME = "scale-ops-v1";
const STATIC_ASSETS = ["/", "/style.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Don't cache API calls or WebSocket upgrades
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// Push notification handler
self.addEventListener("push", (event) => {
  let data = { title: "Scale Ops Alert", body: "New notification" };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {}

  const options = {
    body: data.body,
    icon: "/manifest-icon.png",
    badge: "/manifest-icon.png",
    vibrate: [200, 100, 200],
    data: data.url || "/",
    actions: [
      { action: "view", title: "View" },
      { action: "dismiss", title: "Dismiss" }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      if (windowClients.length) {
        windowClients[0].focus();
      } else {
        clients.openWindow(event.notification.data || "/");
      }
    })
  );
});
