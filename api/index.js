// Berk Kara Randevu — sunucu (Vercel fonksiyonu + Neon Postgres)
// Site her isteği { fn, args } olarak POST eder; cevap { sonuc } ya da { hata }.
import { neon } from "@neondatabase/serverless";
import webpush from "web-push";
import crypto from "node:crypto";

// ---- Ayarlar ----
const ACILIS = 10 * 60, KAPANIS = 21 * 60, KAPALI_GUN = 1; // Pazartesi
const HIZMETLER = {
  sac: { ad: "Saç", fiyat: 400, sure: 30 },
  sacsakal: { ad: "Saç + Sakal", fiyat: 500, sure: 60 },
};
const SAAT_TUTMAYAN = ["Reddedildi", "İptal"];
const KAZANC_SAYILAN = ["Onaylandı", "Geldi"];

const env = (k) => process.env[k] ?? "";
const sql = neon(env("DATABASE_URL") || env("POSTGRES_URL"));
class Hata extends Error {}


// ---- Yardımcılar ----
const pad = (n) => String(n).padStart(2, "0");
const saat_ = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
const istanbul = () => new Date(Date.now() + 3 * 3600_000); // Türkiye UTC+3 (yaz saati yok)
function bugun_() { const d = istanbul(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function simdi_() { const d = istanbul(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function haftaGunu(t) { const [y, m, d] = t.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
const AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const GUN = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
function gunYazi(t) { const p = t.split("-").map(Number); return `${p[2]} ${AY[p[1] - 1]} ${GUN[haftaGunu(t)]}`; }
function yeniKod() { const h = "ABCDEFGHJKLMNPRSTUVYZ23456789"; let k = ""; for (const b of crypto.randomBytes(5)) k += h[b % h.length]; return k; }
const aktif = (r) => !SAAT_TUTMAYAN.includes(r.durum);
const kazanc = (r) => KAZANC_SAYILAN.includes(r.durum);

function anahtar_() {
  const h = crypto.createHash("sha256").update("berk-kara:" + env("PANEL_SIFRE"), "utf8").digest("base64");
  return h.replace(/\+/g, "-").replace(/\//g, "_"); // = dolgusu korunur (eski linklerle uyumlu)
}
function sifreKontrol(s) {
  const v = String(s ?? "");
  if (!env("PANEL_SIFRE") || (v !== env("PANEL_SIFRE") && v !== anahtar_())) throw new Hata("Şifre yanlış.");
}
async function ayar(k) { const r = await sql`select deger from ayarlar where anahtar = ${k}`; return r[0]?.deger ?? ""; }
async function ayarYaz(k, v) { await sql`insert into ayarlar (anahtar, deger) values (${k}, ${v}) on conflict (anahtar) do update set deger = excluded.deger`; }

function e164(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "0") d = "90" + d.slice(1);
  else if (d.length === 10 && d[0] === "5") d = "90" + d;
  if (!/^905\d{9}$/.test(d)) throw new Hata("Geçerli bir cep telefonu numarası yaz (05xx xxx xx xx).");
  return "+" + d;
}

// ---- SMS doğrulama (Twilio Verify) ----
const smsAktif = () => !!(env("TWILIO_SID") && env("TWILIO_TOKEN") && env("TWILIO_VERIFY_SID"));
async function twilio(yol, alanlar) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${env("TWILIO_VERIFY_SID")}/${yol}`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(env("TWILIO_SID") + ":" + env("TWILIO_TOKEN")).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(alanlar),
  });
  const govde = await r.text();
  if (!r.ok) { console.warn("Twilio", yol, r.status, govde); throw new Hata("SMS servisi hata verdi (" + r.status + ")."); }
  return JSON.parse(govde);
}

// ---- Bildirimler ----
async function vapid() {
  let pub = await ayar("vapid_public"), priv = await ayar("vapid_private");
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; await ayarYaz("vapid_public", pub); await ayarYaz("vapid_private", priv); }
  webpush.setVapidDetails("mailto:berkkara.randevu@gmail.com", pub, priv);
  return pub;
}
async function pushGonder(filtre, mesaj) {
  await vapid();
  const aboneler = await sql`select * from bildirim_aboneleri`;
  for (const a of aboneler.filter(filtre)) {
    try { await webpush.sendNotification(a.abonelik, JSON.stringify(mesaj), { TTL: 3600 }); }
    catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from bildirim_aboneleri where endpoint = ${a.endpoint}`;
      else console.warn("push", e?.statusCode, e?.body);
    }
  }
}
async function telegram(metin) {
  const tok = env("TELEGRAM_TOKEN"), chat = await ayar("tg_chat");
  if (!tok || !chat) return;
  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: metin }) }).catch(() => {});
}

// ---- Veri ----
const randevular = (baslangic) => baslangic
  ? sql`select id, kod, tarih::text as tarih, bas, bit, hizmet, fiyat, ad, telefon, durum, hatirlatma, olusturma from randevular where tarih >= ${baslangic}::date`
  : sql`select id, kod, tarih::text as tarih, bas, bit, hizmet, fiyat, ad, telefon, durum, hatirlatma, olusturma from randevular`;
const kapali = (baslangic) => sql`select tarih::text as tarih, bas from kapali_saatler where tarih >= ${baslangic}::date`;

// ---- İşlevler (eski sistemle aynı imzalar) ----
const islevler = {
  async doluSaatler() {
    const b = bugun_();
    const [rs, ks] = await Promise.all([randevular(b), kapali(b)]);
    return {
      bugun: b, simdi: simdi_(), smsZorunlu: smsAktif(),
      dolu: rs.filter(aktif).map((r) => ({ tarih: r.tarih, bas: r.bas, bit: r.bit }))
        .concat(ks.map((k) => ({ tarih: k.tarih, bas: k.bas, bit: k.bas + 60 }))),
    };
  },

  async kodGonder(telefon) {
    if (!smsAktif()) throw new Hata("SMS doğrulaması henüz açık değil.");
    const to = e164(telefon);
    const son = Number(await ayar("sms_son:" + to)) || 0;
    if (Date.now() - son < 60_000) throw new Hata("Kod az önce gönderildi. 1 dakika sonra tekrar isteyebilirsin.");
    await twilio("Verifications", { To: to, Channel: "sms", Locale: "tr" });
    await ayarYaz("sms_son:" + to, String(Date.now()));
    return { numara: to.replace(/^\+90(\d{3})\d{4}(\d{3})$/, "0$1 *** $2") };
  },

  async randevuAl(istek) {
    const h = HIZMETLER[istek?.hizmet];
    const ad = String(istek?.ad ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const tarih = String(istek?.tarih ?? "");
    const bas = Number(istek?.bas);
    const telefon = String(istek?.telefon ?? "").replace(/[^\d+ ]/g, "").trim().slice(0, 20);
    if (!h) throw new Hata("Hizmet seçilmedi.");
    if (ad.split(" ").length < 2) throw new Hata("Lütfen adını ve soyadını yaz.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tarih)) throw new Hata("Gün seçilmedi.");
    if (haftaGunu(tarih) === KAPALI_GUN) throw new Hata("Pazartesi günleri kapalıyız.");
    if (!(bas >= ACILIS && bas + h.sure <= KAPANIS && bas % 60 === 0)) throw new Hata("Bu saat çalışma saatleri dışında.");
    const b = bugun_();
    if (tarih < b || (tarih === b && bas <= simdi_())) throw new Hata("Geçmiş bir saate randevu alınamaz.");
    if (telefon && telefon.replace(/\D/g, "").length < 10) throw new Hata("Telefon numarasını eksiksiz yaz.");
    const ks = await kapali(tarih);
    if (ks.some((k) => k.tarih === tarih && bas < k.bas + 60 && k.bas < bas + h.sure)) throw new Hata("Bu saat kapalı, başka bir saat seç.");
    const ayni = (await randevular(tarih)).filter((r) => r.tarih === tarih && aktif(r));
    if (ayni.some((r) => bas < r.bit && r.bas < bas + h.sure)) throw new Hata("Bu saat az önce doldu, başka bir saat seç.");

    if (smsAktif()) {
      if (!telefon) throw new Hata("Telefon numaranı yaz, doğrulama kodu göndereceğiz.");
      const to = e164(telefon);
      const smsKod = String(istek?.smsKod ?? "").replace(/\D/g, "");
      if (smsKod.length < 4) throw new Hata("Telefonuna gelen doğrulama kodunu yaz.");
      let kontrol = null;
      try { kontrol = await twilio("VerificationCheck", { To: to, Code: smsKod }); } catch { kontrol = null; }
      if (kontrol?.status !== "approved") throw new Hata("Kod yanlış ya da süresi dolmuş. Kontrol et ya da yeni kod iste.");
    }

    let kayit = null;
    for (let i = 0; i < 5 && !kayit; i++) {
      try {
        const r = await sql`insert into randevular (kod, tarih, bas, bit, hizmet, fiyat, ad, telefon, durum)
          values (${yeniKod()}, ${tarih}::date, ${bas}, ${bas + h.sure}, ${h.ad}, ${h.fiyat}, ${ad}, ${telefon || null}, 'Onaylandı')
          returning kod`;
        kayit = r[0];
      } catch (e) {
        if (e?.code === "23P01") throw new Hata("Bu saat az önce doldu, başka bir saat seç.");
        if (e?.code !== "23505") throw e;
      }
    }
    if (!kayit) throw new Hata("Randevu kaydedilemedi, tekrar dene.");
    const sonuc = { kod: kayit.kod, tarih, saat: saat_(bas), bitis: saat_(bas + h.sure), hizmet: h.ad, fiyat: h.fiyat, ad, telefon, durum: "Onaylandı" };
    const metin = `${ad}, ${gunYazi(tarih)} ${sonuc.saat}, ${h.ad} · ${h.fiyat} TL` + (telefon ? `, Tel: ${telefon}` : "");
    await Promise.allSettled([
      pushGonder((a) => a.rol === "berber", { title: "✂️ Yeni randevu", body: metin, url: "/" }),
      telegram("✂️ Yeni randevu\n" + metin),
    ]);
    return sonuc;
  },

  async randevularim(kodlar) {
    const istek = (Array.isArray(kodlar) ? kodlar : []).map((k) => String(k).toUpperCase()).slice(0, 20);
    if (!istek.length) return [];
    const rs = await sql`select id, kod, tarih::text as tarih, bas, bit, hizmet, fiyat, ad, telefon, durum, hatirlatma, olusturma from randevular where kod = any(${istek})`;
    return rs.map((r) => ({ kod: r.kod, tarih: r.tarih, saat: saat_(r.bas), hizmet: r.hizmet, fiyat: r.fiyat, durum: r.durum }));
  },

  async musteriIptal(kod) {
    const r = (await sql`select id, kod, tarih::text as tarih, bas, bit, hizmet, fiyat, ad, telefon, durum, hatirlatma, olusturma from randevular where kod = ${String(kod).toUpperCase()}`)[0];
    if (!r) throw new Hata("Randevu bulunamadı.");
    if (!aktif(r)) throw new Hata("Bu randevu zaten iptal edilmiş.");
    const b = bugun_();
    if (r.tarih < b || (r.tarih === b && r.bas <= simdi_())) throw new Hata("Saati geçmiş randevu iptal edilemez.");
    await sql`update randevular set durum = 'İptal' where id = ${r.id}`;
    const metin = `${r.ad}, ${gunYazi(r.tarih)} ${saat_(r.bas)} randevusunu iptal etti.`;
    await Promise.allSettled([pushGonder((a) => a.rol === "berber", { title: "❌ Randevu iptal", body: metin, url: "/" }), telegram("❌ " + metin)]);
    return true;
  },

  async berberPaneli(sifre, gun) {
    sifreKontrol(sifre);
    const tum = await randevular();
    const b = bugun_(), simdi = simdi_(), ay = b.slice(0, 7), secili = /^\d{4}-\d{2}-\d{2}$/.test(String(gun)) ? gun : b;
    const aylar = {};
    tum.filter(kazanc).forEach((r) => { const k = r.tarih.slice(0, 7); aylar[k] ??= { ay: k, adet: 0, kazanc: 0 }; aylar[k].adet++; aylar[k].kazanc += r.fiyat; });
    const satir = (r) => ({ kod: r.kod, tarih: r.tarih, saat: saat_(r.bas), bitis: saat_(r.bit), ad: r.ad, telefon: r.telefon ?? "", hizmet: r.hizmet, fiyat: r.fiyat, durum: r.durum, gecti: r.tarih < b || (r.tarih === b && r.bas <= simdi) });
    const buAyListe = tum.filter((r) => kazanc(r) && r.tarih.startsWith(ay));
    const ks = await kapali(secili);
    return {
      bugun: b, gun: secili, anahtar: anahtar_(),
      bekleyen: tum.filter((r) => r.durum === "Bekliyor" && (r.tarih > b || (r.tarih === b && r.bit > simdi))).sort((x, y) => x.tarih.localeCompare(y.tarih) || x.bas - y.bas).map(satir),
      kapali: ks.filter((k) => k.tarih === secili).map((k) => k.bas),
      liste: tum.filter((r) => r.tarih === secili && aktif(r)).sort((x, y) => x.bas - y.bas).map(satir),
      buAy: aylar[ay] ?? { ay, adet: 0, kazanc: 0 },
      buAyKazanilan: buAyListe.filter((r) => r.tarih < b || (r.tarih === b && r.bit <= simdi)).reduce((t, r) => t + r.fiyat, 0),
      aylar: Object.keys(aylar).sort().reverse().map((k) => aylar[k]),
    };
  },

  async durumGuncelle(sifre, kod, yeni) {
    sifreKontrol(sifre);
    if (!["Onaylandı", "Reddedildi", "İptal", "Geldi", "Gelmedi"].includes(yeni)) throw new Hata("Geçersiz işlem.");
    const r = await sql`update randevular set durum = ${yeni} where kod = ${String(kod)} returning kod`;
    if (!r.length) throw new Hata("Randevu bulunamadı.");
    return true;
  },

  async saatleriAyarla(sifre, tarih, saatler, kapat) {
    sifreKontrol(sifre);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tarih))) throw new Hata("Gün seçilmedi.");
    const liste = (Array.isArray(saatler) ? saatler : []).map(Number).filter((n) => Number.isInteger(n));
    if (!liste.length) return true;
    if (kapat) await sql`insert into kapali_saatler (tarih, bas) select ${tarih}::date, unnest(${liste}::int[]) on conflict do nothing`;
    else await sql`delete from kapali_saatler where tarih = ${tarih}::date and bas = any(${liste}::int[])`;
    return true;
  },

  // ---- Bildirim aboneliği ----
  async bildirimAnahtari() { return await vapid(); },
  async bildirimAbone(abonelik, rol, kodlarVeyaSifre) {
    if (!abonelik?.endpoint) throw new Hata("Bildirim aboneliği alınamadı.");
    let kodlar = [];
    if (rol === "berber") sifreKontrol(kodlarVeyaSifre);
    else kodlar = (Array.isArray(kodlarVeyaSifre) ? kodlarVeyaSifre : []).map((k) => String(k).toUpperCase()).slice(0, 20);
    const r = rol === "berber" ? "berber" : "musteri";
    await sql`insert into bildirim_aboneleri (endpoint, abonelik, rol, kodlar) values (${abonelik.endpoint}, ${JSON.stringify(abonelik)}::jsonb, ${r}, ${kodlar}::text[])
      on conflict (endpoint) do update set abonelik = excluded.abonelik, rol = excluded.rol, kodlar = excluded.kodlar`;
    return true;
  },
  async bildirimDene(sifre) {
    sifreKontrol(sifre);
    await pushGonder((a) => a.rol === "berber", { title: "✅ Bildirimler açık", body: "Yeni randevular buraya bildirim olarak gelecek.", url: "/" });
    return true;
  },

  // ---- Telegram: bota Start'a basıldıktan sonra bir kez çağrılır ----
  async telegramBagla(sifre) {
    sifreKontrol(sifre);
    const tok = env("TELEGRAM_TOKEN"); if (!tok) throw new Hata("TELEGRAM_TOKEN girilmemiş.");
    const res = await (await fetch(`https://api.telegram.org/bot${tok}/getUpdates`)).json();
    const m = (res.result ?? []).filter((u) => u.message?.chat);
    if (!m.length) throw new Hata("Bot mesaj görmedi. Telegram'da bota bir mesaj yaz, sonra tekrar dene.");
    await ayarYaz("tg_chat", String(m[m.length - 1].message.chat.id));
    await telegram("✅ Berk Kara Randevu yeni siteye bağlandı.");
    return true;
  },

  // ---- Zamanlayıcı (GitHub Actions her 15 dakikada çağırır) ----
  async hatirlatma() {
    const b = bugun_(), simdi = simdi_();
    const rs = (await randevular(b)).filter((r) => r.tarih === b && r.durum === "Onaylandı" && !r.hatirlatma);
    let n = 0;
    for (const r of rs) {
      const kalan = r.bas - simdi;
      if (kalan <= 0 || kalan > 120) continue;
      const olusturma = new Date(new Date(r.olusturma).getTime() + 3 * 3600_000);
      const ayniGun = olusturma.toISOString().slice(0, 10) === b;
      if (ayniGun && r.bas - (olusturma.getUTCHours() * 60 + olusturma.getUTCMinutes()) < 150) {
        await sql`update randevular set hatirlatma = 'Gerek yok' where id = ${r.id}`; continue;
      }
      await pushGonder((a) => a.rol === "musteri" && (a.kodlar ?? []).includes(r.kod), {
        title: "⏰ Randevun yaklaşıyor", body: `Bugün ${saat_(r.bas)}'de randevun var (${r.hizmet}). Gelemeyeceksen lütfen iptal et.`, url: "/",
      });
      await sql`update randevular set hatirlatma = ${"Gönderildi " + saat_(simdi)} where id = ${r.id}`;
      n++;
    }
    return { gonderilen: n };
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  try {
    let govde = req.body;
    if (typeof govde === "string") govde = JSON.parse(govde || "{}");
    const { fn, args } = govde ?? {};
    const f = Object.prototype.hasOwnProperty.call(islevler, fn) ? islevler[fn] : null;
    if (!f) throw new Hata("Bilinmeyen işlem.");
    const sonuc = await f(...(Array.isArray(args) ? args : []));
    res.status(200).json({ sonuc });
  } catch (e) {
    if (!(e instanceof Hata)) console.error(e);
    res.status(200).json({ hata: e instanceof Hata ? e.message : "Bir sorun oluştu, tekrar dene." });
  }
}
