# SAP User Management — To'liq Flow

Hamma user'lar SAP `OSLP` jadvalida. GET so'rovlar SQL, CREATE/UPDATE Service Layer orqali.
Parol plaintext (`U_password`). Avatar, isActive, isDeleted Mongo'da (`SalesPersonProfile`).

## Huquqlar matritsasi

| Amal | CEO | Manager | Admin | Boshqa |
|---|---|---|---|---|
| User yaratish | ✓ | ✓ | ✓ | – |
| Asosiy maydonlarni yangilash (name, mobile, branch, ...) | ✓ | ✓ | ✓ | – |
| **Role o'zgartirish** | ✓ | ✓ | – | – |
| Activate / Deactivate | ✓ | ✓ | ✓ | – |
| **O'chirish (soft delete)** | ✓ | ✓ | – | – |
| **Tiklash (restore)** | ✓ | ✓ | – | – |
| Avatar yuklash (boshqalarga) | ✓ | ✓ | ✓ | – |
| Avatar yuklash (o'ziga) | ✓ | ✓ | ✓ | ✓ |
| Login/parolni o'zgartirish (o'ziga) | ✓ | ✓ | ✓ | ✓ |

---

## 0. Tayyorgarlik

`.env` da:
```
secret_key=...
BOT_TOKEN=...
db=...
api=https://your-sap-host/b1s/v1
service_layer_username=...
service_layer_password=...

OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_MS=60000
```

User Telegram bot'ga **avval `/start` bosib raqamini yuborgan bo'lishi shart**.

---

## FLOW 1 — Admin yangi user yaratadi

### 1.1. Admin login
`POST /api/login`
```json
{ "login": "CEO", "password": "3630999" }
```

### 1.2. Yangi user yaratish
`POST /api/sap-users` (Authorization)
```json
{
  "fullName": "Yangi Sotuvchi",
  "login": "yangi.sotuvchi",
  "role": "Seller",
  "branch": "1",
  "mobile": "998901234567",
  "onlinePbx": "115",
  "workDay": "1,2,3,4,5",
  "summa": 3000000
}
```
**Response:**
```json
{
  "data": { "SlpCode": 90, "SlpName": "Yangi Sotuvchi", "U_login": "yangi.sotuvchi", "isActive": true, "isDeleted": false },
  "message": "User yaratildi. Parol /auth/forgot/otp orqali o'rnatiladi."
}
```

---

## OTP oqimlari (umumiy struktura)

Hamma OTP-asosli oqim **3 bosqichli**:
1. **OTP yuborish** — `/otp` (telefon → kod Telegram'ga)
2. **OTP tasdiqlash** — `/verify` (kod → **regToken** qaytaradi, TTL 10 min)
3. **Yakuniy amal** — `/register` | `/forgot/reset` | `PATCH /me/credentials` (regToken + parol)

> `regToken` — bir martalik JWT, ichida `{ otpId, slpCode, purpose }`. Frontend uni saqlab qo'yadi va keyingi so'rovda yuboradi.

---

## FLOW 2 — User birinchi marta parol o'rnatadi (REGISTER)

> Faqat **U_password BO'SH** bo'lgan akkauntlar uchun.

### 2.1. OTP yuborish
`POST /api/auth/register/otp`
```json
{ "phone": "998901234567" }
```

### 2.2. OTP'ni tasdiqlash → regToken
`POST /api/auth/register/verify`
```json
{ "phone": "998901234567", "code": "482917" }
```
**Response:**
```json
{
  "verified": true,
  "regToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresAt": "..."
}
```

### 2.3. Parolni o'rnatish (regToken bilan)
`POST /api/auth/register`
```json
{
  "regToken": "eyJhbGciOiJIUzI1NiIs...",
  "password": "Parol123",
  "passwordConfirm": "Parol123"
}
```
**Response:**
```json
{ "message": "Parol o'rnatildi", "slpCode": 90, "login": "yangi.sotuvchi" }
```

### 2.4. Login
`POST /api/login` { login, password }

---

## FLOW 3 — Parolni unutish (FORGOT)

> Faqat **U_password TO'LDIRILGAN** akkauntlar uchun.

### 3.1. OTP yuborish
`POST /api/auth/forgot/otp`
```json
{ "phone": "998901234567" }
```

### 3.2. OTP'ni tasdiqlash → regToken
`POST /api/auth/forgot/verify`
```json
{ "phone": "998901234567", "code": "482917" }
```
**Response:**
```json
{ "verified": true, "regToken": "eyJ...", "expiresAt": "..." }
```

### 3.3. Yangi parolni o'rnatish (regToken bilan)
`POST /api/auth/forgot/reset`
```json
{
  "regToken": "eyJ...",
  "newPassword": "YangiParol",
  "passwordConfirm": "YangiParol"
}
```
**Response:**
```json
{ "message": "Parol yangilandi", "slpCode": 26, "login": "ali" }
```

### 3.4. Yangi parol bilan login
`POST /api/login`

---

## FLOW 4 — Login va parolni birga o'zgartirish (token, 3 bosqich)

> Login va parol **HAR DOIM birga** yangilanadi.
> Joriy parol so'ralmaydi — OTP yetarli.

### 4.1. OTP yuborish
`POST /api/me/credentials/otp` (token)

Body yo'q.

**Response:**
```json
{ "delivered": true, "chatHint": "99890***67", "expiresAt": "..." }
```

### 4.2. OTP'ni tasdiqlash
`POST /api/me/credentials/verify` (token)
```json
{ "code": "482917" }
```
**Response:**
```json
{ "verified": true, "expiresAt": "..." }
```

### 4.3. Login va parolni yangilash (kod kerak emas)
`PATCH /api/me/credentials` (token)
```json
{
  "newLogin": "yangi.login",
  "newPassword": "YangiParol123",
  "passwordConfirm": "YangiParol123"
}
```

**Response:**
```json
{ "message": "Login va parol yangilandi" }
```

> Agar yangi login eskisi bilan bir xil bo'lsa, faqat parol yangilanadi (login band tekshiruvi o'tkazilmaydi).
> Agar ikkalasi ham eskisi bilan bir xil bo'lsa: `400 — "Yangi login va parol eskisi bilan bir xil"`.

---

## FLOW 5 — Profil va avatar

### 5.1. Profil
`GET /api/me` (token)
```json
{
  "data": {
    "SlpCode": 26, "SlpName": "Ali", "U_login": "ali", "U_role": "OperatorM",
    "Mobil": "998903367448", "isActive": true, "isDeleted": false,
    "avatar": { "keys": {}, "urls": {} }
  }
}
```

### 5.2. Avatar yuklash
`POST /api/me/avatar` (multipart, token) — `avatar=<file>`

---

## FLOW 6 — Admin user'ni yangilaydi

### 6.1. Ro'yxat
`GET /api/sap-users` (admin)

Query parametrlari:
- `search` — name/login/phone
- `role` — masalan `Operator1`
- `branch` — `1`, `2`, ...
- `isActive` — `true` / `false`
- `includeDeleted` — `true` (default `false` — o'chirilganlar yashiringan)

### 6.2. Yangilash
`PATCH /api/sap-users/26` (admin)
```json
{
  "fullName": "Ali V.",
  "branch": "2",
  "mobile": "998901112233",
  "onlinePbx": "120"
}
```

> **Role o'zgartirish:**
> ```json
> { "role": "Operator2" }
> ```
> Faqat CEO va Manager qila oladi. Admin urinsa **403** qaytadi.

### 6.3. Avatar
`POST /api/sap-users/26/avatar` (multipart, admin)

---

## FLOW 7 — Faollashtirish / nofaol qilish

### 7.1. Nofaol qilish
`POST /api/sap-users/90/deactivate` (admin)

User endi `/login` orqali kira olmaydi:
```json
{ "message": "Akkaunt aktiv emas. Admin bilan bog'laning." }
```

### 7.2. Qaytadan faollashtirish
`POST /api/sap-users/90/activate` (admin)

> **Eslatma:** o'chirilgan (deleted) akkauntni faqat `restore` orqali tiklash mumkin, `activate` ishlamaydi.

---

## FLOW 8 — O'chirish va tiklash (CEO/Manager)

### 8.1. O'chirish
`DELETE /api/sap-users/90` (CEO yoki Manager)

Bu **soft delete**:
- `isDeleted=true`, `isActive=false` (Mongo)
- SAP OSLP'da hech narsa o'chmaydi
- User `/login` orqali kira olmaydi
- `GET /sap-users` ro'yxatda ko'rinmaydi (default)

```json
{ "data": { "slpCode": 90, "isDeleted": true, "deletedAt": "..." } }
```

### 8.2. Tiklash
`POST /api/sap-users/90/restore` (CEO yoki Manager)
- `isDeleted=false`, `isActive=true`

### 8.3. O'chirilganlarni ko'rish
`GET /api/sap-users?includeDeleted=true` — barcha userlar ro'yxati (deleted'lar ham).

---

## XATOLIKLAR

| Status | Sabab |
|---|---|
| 400 | Validatsiya, OTP noto'g'ri/muddati o'tgan, login band, allaqachon o'chirilgan |
| 401 | Token yo'q yoki yaroqsiz |
| 403 | Sizda huquq yo'q (role guard yoki ichki cheklash) |
| 500 | SAP Service Layer xatosi |

Hamma xatolar bir xil format'da:
```json
{ "message": "Xatolik matni", "errors": [] }
```

---

## XAVFSIZLIK QOIDALARI

- OTP **6 raqam**, **hash** holatida saqlanadi, **5 daqiqa** TTL
- **Max 5 urinish** — keyin yangi kod so'rashga majbur
- **60 soniya cooldown** — yangi kod so'rashlar orasida
- OTP iste'mol qilishdan oldin barcha validatsiyalar (login band, parol mos)
- `isDeleted=true` yoki `isActive=false` user `/login` orqali kira olmaydi
- `forgot/otp` ham deleted/inactive userlarni rad etadi
- O'zingizni o'chira/aktivsiz qila olmaysiz
- O'chirilgan akkauntni `activate` qilib bo'lmaydi — avval `restore`

---

## TG BOT ESLATMASI

OTP yuborish uchun userning telefon raqami (SAP'dagi `Mobil` yoki `Telephone`) **`User` (telegram bot) modelidagi `phone`** bilan oxirgi 9 raqamda mos kelishi va `chat_id`'si bo'sh bo'lmasligi kerak.
