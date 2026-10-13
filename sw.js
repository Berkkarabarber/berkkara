// Berk Kara Randevu — bildirim servisi
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // ana ekrana eklenebilirlik için
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: "Berk Kara", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Berk Kara", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ("focus" in w) { w.postMessage("yenile"); return w.focus(); }
    return clients.openWindow(e.notification.data.url || "/");
  }));
});
