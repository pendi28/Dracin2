# Pendi Drama Player — Firebase + GitHub Actions

Drama player dengan auto-deploy ke Firebase Hosting setiap push ke branch `main`.

---

## Struktur Folder

```
pendi-firebase/
├── .github/
│   └── workflows/
│       └── deploy.yml       → GitHub Actions: auto-deploy ke Firebase
├── firebase.json            → Konfigurasi hosting + functions + rewrites
├── .firebaserc              → Project ID Firebase kamu
├── firestore.rules          → Aturan keamanan Firestore
├── firestore.indexes.json   → Index Firestore
├── functions/
│   ├── index.js             → Cloud Functions (API + Scraper)
│   └── package.json         → Dependensi functions
└── public/
    ├── index.html           → Drama browser + player (user)
    └── admin.html           → Panel admin
```

---

## Setup Awal (Sekali Saja)

### Langkah 1 — Buat Project Firebase

1. Buka https://console.firebase.google.com
2. Klik **Add project** → isi nama → buat project
3. Aktifkan **Firestore** → Build → Firestore Database → Create database → Start in production mode → pilih region Asia
4. Aktifkan **Firebase Hosting** → Hosting → Get started

### Langkah 2 — Isi Firebase Config di HTML

Buka **Firebase Console → Project Settings → Your apps → Add app (Web)**

Salin config dan tempel ke bagian `firebaseConfig` di:
- `public/index.html` (sekitar baris 118)
- `public/admin.html` (sekitar baris 153)

```js
const firebaseConfig = {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "..."
};
```

### Langkah 3 — Isi Project ID di .firebaserc

Edit file `.firebaserc`:
```json
{
  "projects": {
    "default": "project-id-kamu"
  }
}
```

### Langkah 4 — Buat Service Account untuk GitHub Actions

1. Buka **Firebase Console → Project Settings → Service accounts**
2. Klik **Generate new private key** → download file JSON
3. Buka file JSON tersebut, salin **seluruh isinya**

### Langkah 5 — Tambah GitHub Secrets

Buka repo GitHub kamu → **Settings → Secrets and variables → Actions → New repository secret**

Tambah dua secrets berikut:

| Secret Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Seluruh konten file JSON service account dari langkah 4 |
| `ADMIN_KEY` | Password admin panel kamu (bebas, contoh: `rahasia123`) |

### Langkah 6 — Upload ke GitHub & Push

Upload seluruh isi folder ini ke repo GitHub kamu (termasuk folder `.github/`), lalu push ke branch `main`.

GitHub Actions akan otomatis jalan dan deploy ke Firebase!

---

## Cara Kerja Auto-Deploy

```
Push ke branch main
        ↓
GitHub Actions (.github/workflows/deploy.yml)
        ↓
Install dependencies functions/
        ↓
Set ADMIN_KEY ke Firebase Functions config
        ↓
firebase deploy --non-interactive
        ↓
App live di https://PROJECT_ID.web.app
```

---

## URL Setelah Deploy

- **Drama Player** : `https://PROJECT_ID.web.app`
- **Admin Panel**  : `https://PROJECT_ID.web.app/admin.html`

---

## Cara Pakai Admin Panel

1. Buka `https://PROJECT_ID.web.app/admin.html`
2. Login dengan `ADMIN_KEY` yang kamu set di GitHub Secrets
3. **Scrape Katalog** → ambil semua drama dari DramaBox (1–2 menit)
4. Klik drama → **Refresh Episode** untuk ambil episode
5. Toggle episode (merah = kunci, hijau = buka) → **Simpan Lock**

---

## Update Drama Expired

Drama "expired" = URL video sudah tidak valid. Solusi:
1. Buka Admin Panel → cari drama yang expired
2. Klik **Refresh Episode** → scrape ulang URL terbaru
3. Selesai, user langsung bisa nonton lagi

---

## Arsitektur

```
User → Firebase Hosting (index.html)
           ↓ baca via Firestore SDK
       Firestore Database
           dramas/{bookId}    → info drama + lockedEpisodes
           episodes/{bookId}  → semua episode dengan rawUrl

User → /api/decrypt?url=... → Cloud Functions → nb-dramabox-gentoken.vercel.app → video

Admin → /admin.html → Firestore SDK (baca) + /api/admin/* (Cloud Functions)
```

---

## Catatan

- Episode tersimpan di Firestore → loading INSTAN
- URL video terenkripsi (rawUrl), didekripsi saat play
- Cloud Functions timeout: 9 menit (cukup untuk drama 100+ episode)
- Admin Key tersimpan aman di Firebase environment variables
