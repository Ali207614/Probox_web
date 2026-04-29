'use strict';

const { execute } = require('../services/dbService');
const { slPost, slPatch } = require('../services/sl-client.service');
const { db } = require('../config');

const ApiError = require('../exceptions/api-error');
const otpService = require('../services/otp.service');
const SalesPersonProfile = require('../models/sales-person-profile-model');
const UploadService = require('../minio');

const uploadService = new UploadService();

const ADMIN_ROLES = new Set(['CEO', 'Manager', 'Admin']);
const ROLE_CHANGE_ROLES = new Set(['CEO', 'Manager']);
const DELETE_ROLES = new Set(['CEO', 'Manager']);

// ---- helpers ----

function isAdminReq(req) {
    return ADMIN_ROLES.has(String(req.user?.U_role || ''));
}

function canChangeRoleReq(req) {
    return ROLE_CHANGE_ROLES.has(String(req.user?.U_role || ''));
}

function canDeleteReq(req) {
    return DELETE_ROLES.has(String(req.user?.U_role || ''));
}

function escapeSqlString(raw) {
    return String(raw == null ? '' : raw).replace(/'/g, "''");
}

function normalizePhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 12 && d.startsWith('998')) return d;
    if (d.length === 9) return '998' + d;
    if (d.length > 9) return '998' + d.slice(-9);
    return null;
}

function normalizeLogin(raw) {
    return String(raw || '').trim();
}

const ALLOWED_LOGIN_RE = /^[A-Za-z0-9._-]{3,64}$/;

// SQL: bitta foydalanuvchi yoki ko'pi
function buildOslpSql({ slpCode = null, search = '', login = null, phone = null }) {
    const where = ['1=1'];
    if (slpCode != null) where.push(`T0."SlpCode" = ${Number(slpCode)}`);
    if (login) where.push(`T0."U_login" = '${escapeSqlString(login)}'`);
    if (phone) {
        const last9 = String(phone).replace(/\D/g, '').slice(-9);
        if (last9) {
            where.push(
                `(T0."Mobil" LIKE '%${last9}' OR T0."Telephone" LIKE '%${last9}')`
            );
        }
    }
    if (search) {
        const s = escapeSqlString(search);
        where.push(
            `(LOWER(T0."SlpName") LIKE LOWER('%${s}%') OR LOWER(T0."U_login") LIKE LOWER('%${s}%') OR T0."Mobil" LIKE '%${s}%')`
        );
    }

    return `
        SELECT
            T0."SlpCode",
            T0."SlpName",
            T0."Telephone",
            T0."Mobil",
            T0."U_login",
            T0."U_password",
            T0."U_role",
            T0."U_summa",
            T0."U_workDay",
            T0."U_branch",
            T0."U_onlinepbx"
        FROM ${db}.OSLP T0
        WHERE ${where.join(' AND ')}
        ORDER BY T0."SlpCode" DESC
    `;
}

async function fetchOslp(opts) {
    const rows = await execute(buildOslpSql(opts));
    return rows || [];
}

async function attachProfile(rows) {
    if (!rows.length) return rows;
    const codes = rows.map((r) => Number(r.SlpCode)).filter(Number.isFinite);
    const profiles = await SalesPersonProfile.find({ slpCode: { $in: codes } }).lean();
    const map = new Map(profiles.map((p) => [Number(p.slpCode), p]));

    const result = [];
    for (const row of rows) {
        const profile = map.get(Number(row.SlpCode));
        let avatar = null;
        if (profile?.avatar?.keys) {
            try {
                const urls = await uploadService.generateSignedUrls(profile.avatar.keys);
                avatar = { keys: profile.avatar.keys, urls };
            } catch (err) {
                console.error('[SAP user] avatar url error:', err?.message || err);
            }
        }
        result.push({
            ...row,
            avatar,
            isActive: profile ? profile.isActive !== false : true,
            isDeleted: profile?.isDeleted === true,
            deactivatedAt: profile?.deactivatedAt || null,
            deletedAt: profile?.deletedAt || null,
        });
    }
    return result;
}

function filterByProfileQuery(rows, { isActive, includeDeleted }) {
    let out = rows;
    if (!includeDeleted) out = out.filter((r) => !r.isDeleted);
    if (typeof isActive !== 'undefined') {
        const want = String(isActive) === 'true';
        out = out.filter((r) => r.isActive === want);
    }
    return out;
}

async function ensureProfile(slpCode) {
    let p = await SalesPersonProfile.findOne({ slpCode });
    if (!p) {
        p = await SalesPersonProfile.create({ slpCode });
    }
    return p;
}

function publicView(row) {
    if (!row) return null;
    const { U_password, ...rest } = row;
    return rest;
}

function publicViewKeepPassword(row) {
    return row;
}

// ---- Controller ----

class SapUserController {

    // ===== ADMIN: list (SQL) =====
    list = async (req, res, next) => {
        try {
            const { search, role, branch, isActive, includeDeleted } = req.query;
            const rows = await fetchOslp({ search });

            let filtered = rows;
            if (role) filtered = filtered.filter((r) => String(r.U_role) === String(role));
            if (branch) filtered = filtered.filter((r) => String(r.U_branch) === String(branch));

            const withProfile = await attachProfile(filtered);
            const final = filterByProfileQuery(withProfile, {
                isActive,
                includeDeleted: String(includeDeleted) === 'true',
            });

            const isAdminUser = isAdminReq(req);
            const data = final.map((r) => (isAdminUser ? publicViewKeepPassword(r) : publicView(r)));

            return res.json({ data, total: data.length });
        } catch (e) {
            return next(e);
        }
    };

    // ===== ADMIN: getOne (SQL) =====
    getOne = async (req, res, next) => {
        try {
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }
            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));
            const [row] = await attachProfile(rows);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== ADMIN: create (SL) =====
    create = async (req, res, next) => {
        try {
            const {
                fullName,
                login,
                role,
                branch,
                mobile,
                telephone,
                onlinePbx,
                workDay,
                summa,
            } = req.body || {};

            if (!fullName) return next(ApiError.BadRequest('fullName majburiy'));
            if (!role) return next(ApiError.BadRequest('role majburiy'));

            const normalizedLogin = login ? normalizeLogin(login) : null;
            if (normalizedLogin && !ALLOWED_LOGIN_RE.test(normalizedLogin)) {
                return next(ApiError.BadRequest("login formati noto'g'ri (3-64 belgi)"));
            }

            const normalizedMobile = mobile ? normalizePhone(mobile) : null;
            if (mobile && !normalizedMobile) {
                return next(ApiError.BadRequest("mobile noto'g'ri formatda"));
            }

            // Login band emasligini SAP'da tekshirish
            if (normalizedLogin) {
                const dup = await fetchOslp({ login: normalizedLogin });
                if (dup.length) {
                    return next(ApiError.BadRequest('Bu login band'));
                }
            }

            // Service Layer body
            const body = {
                SalesEmployeeName: String(fullName).trim(),
                U_role: String(role),
            };
            if (normalizedLogin) body.U_login = normalizedLogin;
            if (normalizedMobile) body.Mobile = normalizedMobile;
            if (telephone) body.Telephone = String(telephone).trim();
            if (branch) body.U_branch = String(branch);
            if (onlinePbx) body.U_onlinepbx = String(onlinePbx);
            if (workDay) body.U_workDay = String(workDay);
            if (summa != null && summa !== '') body.U_summa = Number(summa);

            const created = await slPost('/SalesPersons', body);

            // Avatar (multipart bilan kelgan bo'lsa)
            const slpCode = Number(created?.SalesEmployeeCode);
            if (req.file && Number.isFinite(slpCode)) {
                const uploaded = await uploadService.uploadProfilePicture(String(slpCode), req.file);
                await SalesPersonProfile.findOneAndUpdate(
                    { slpCode },
                    { $set: { slpCode, avatar: { keys: uploaded.keys } } },
                    { upsert: true, new: true }
                );
            }

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);

            return res.status(201).json({
                data: publicViewKeepPassword(row || created),
                message: normalizedLogin
                    ? 'User yaratildi. Parol o\'rnatish uchun /auth/forgot/otp orqali davom etsin.'
                    : 'User yaratildi.',
            });
        } catch (e) {
            if (e.status) return next(new ApiError(e.status, e.message));
            return next(e);
        }
    };

    // ===== ADMIN: update (SL) — login/parol BU YERDA o'zgarmaydi =====
    update = async (req, res, next) => {
        try {
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }

            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const { fullName, role, branch, mobile, telephone, onlinePbx, workDay, summa } =
                req.body || {};

            // Role o'zgartirish faqat CEO/Manager qo'lida
            if (typeof role === 'string' && role.trim() && role.trim() !== rows[0].U_role) {
                if (!canChangeRoleReq(req)) {
                    return next(
                        new ApiError(403, "Role o'zgartirish faqat CEO va Manager huquqida")
                    );
                }
            }

            const body = {};
            if (typeof fullName === 'string' && fullName.trim()) body.SalesEmployeeName = fullName.trim();
            if (typeof role === 'string' && role.trim()) body.U_role = role.trim();
            if (typeof branch !== 'undefined') body.U_branch = branch == null ? null : String(branch);
            if (typeof mobile !== 'undefined') {
                if (mobile == null || mobile === '') {
                    body.Mobile = null;
                } else {
                    const m = normalizePhone(mobile);
                    if (!m) return next(ApiError.BadRequest("mobile noto'g'ri formatda"));
                    body.Mobile = m;
                }
            }
            if (typeof telephone !== 'undefined') {
                body.Telephone = telephone == null || telephone === '' ? null : String(telephone).trim();
            }
            if (typeof onlinePbx !== 'undefined') {
                body.U_onlinepbx = onlinePbx == null ? null : String(onlinePbx);
            }
            if (typeof workDay !== 'undefined') {
                body.U_workDay = workDay == null ? null : String(workDay);
            }
            if (typeof summa !== 'undefined') {
                body.U_summa = summa == null || summa === '' ? null : Number(summa);
            }

            if (!Object.keys(body).length) {
                return next(ApiError.BadRequest("O'zgartirish uchun ma'lumot yo'q"));
            }

            await slPatch(`/SalesPersons(${slpCode})`, body);

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            if (e.status) return next(new ApiError(e.status, e.message));
            return next(e);
        }
    };

    // ===== ADMIN: avatar upload =====
    uploadAvatarForUser = async (req, res, next) => {
        try {
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }
            if (!req.file) return next(ApiError.BadRequest('Fayl yuklanmadi'));

            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const oldProfile = await SalesPersonProfile.findOne({ slpCode }).lean();
            const oldKeys = oldProfile?.avatar?.keys
                ? Object.values(oldProfile.avatar.keys).filter(Boolean)
                : [];

            const uploaded = await uploadService.uploadProfilePicture(String(slpCode), req.file);
            await SalesPersonProfile.findOneAndUpdate(
                { slpCode },
                { $set: { slpCode, avatar: { keys: uploaded.keys } } },
                { upsert: true, new: true }
            );

            if (oldKeys.length) {
                uploadService
                    .deleteImages(oldKeys)
                    .catch((err) =>
                        console.error('[SAP user] eski avatar o\'chirishda xatolik:', err?.message || err)
                    );
            }

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== SELF: me =====
    me = async (req, res, next) => {
        try {
            const slpCode = Number(req.user?.SlpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.UnauthorizedError());
            }
            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.UnauthorizedError());
            const [row] = await attachProfile(rows);
            return res.json({ data: publicView(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== SELF: avatar upload =====
    uploadMyAvatar = async (req, res, next) => {
        try {
            const slpCode = Number(req.user?.SlpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.UnauthorizedError());
            }
            if (!req.file) return next(ApiError.BadRequest('Fayl yuklanmadi'));

            const oldProfile = await SalesPersonProfile.findOne({ slpCode }).lean();
            const oldKeys = oldProfile?.avatar?.keys
                ? Object.values(oldProfile.avatar.keys).filter(Boolean)
                : [];

            const uploaded = await uploadService.uploadProfilePicture(String(slpCode), req.file);
            await SalesPersonProfile.findOneAndUpdate(
                { slpCode },
                { $set: { slpCode, avatar: { keys: uploaded.keys } } },
                { upsert: true, new: true }
            );

            if (oldKeys.length) {
                uploadService
                    .deleteImages(oldKeys)
                    .catch((err) =>
                        console.error('[SAP user] eski avatar o\'chirishda xatolik:', err?.message || err)
                    );
            }

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicView(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== SELF: OTP request (token) =====
    requestCredentialsOtp = async (req, res, next) => {
        try {
            const slpCode = Number(req.user?.SlpCode);
            if (!Number.isFinite(slpCode)) return next(ApiError.UnauthorizedError());

            const { purpose } = req.body || {};
            if (!['change_login', 'change_password', 'change_credentials'].includes(purpose)) {
                return next(ApiError.BadRequest("purpose noto'g'ri"));
            }

            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.UnauthorizedError());
            const phone = rows[0].Mobil || rows[0].Telephone;

            const result = await otpService.sendOtp({ slpCode, phone, purpose });
            return res.json({
                message: "Tasdiqlash kodi Telegram orqali jo'natildi",
                ...result,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ===== SELF: change credentials with OTP (token) =====
    //   Joriy parol so'ralmaydi — OTP ikkinchi faktor sifatida yetarli.
    changeCredentials = async (req, res, next) => {
        try {
            const slpCode = Number(req.user?.SlpCode);
            if (!Number.isFinite(slpCode)) return next(ApiError.UnauthorizedError());

            const { purpose, code, newLogin, newPassword, passwordConfirm } = req.body || {};

            if (!['change_login', 'change_password', 'change_credentials'].includes(purpose)) {
                return next(ApiError.BadRequest("purpose noto'g'ri"));
            }
            if (!code) return next(ApiError.BadRequest('OTP kod majburiy'));

            const wantsLogin =
                purpose === 'change_login' || (purpose === 'change_credentials' && newLogin);
            const wantsPassword =
                purpose === 'change_password' || (purpose === 'change_credentials' && newPassword);

            if (purpose === 'change_login' && !newLogin) {
                return next(ApiError.BadRequest('newLogin majburiy'));
            }
            if (purpose === 'change_password' && !newPassword) {
                return next(ApiError.BadRequest('newPassword majburiy'));
            }
            if (purpose === 'change_credentials' && !wantsLogin && !wantsPassword) {
                return next(
                    ApiError.BadRequest('newLogin yoki newPassword (yoki ikkalasi) majburiy')
                );
            }

            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.UnauthorizedError());
            const me = rows[0];

            // Validatsiya — OTP'ni iste'mol qilishdan oldin
            let normalizedLogin = null;
            if (wantsLogin) {
                normalizedLogin = normalizeLogin(newLogin);
                if (!ALLOWED_LOGIN_RE.test(normalizedLogin)) {
                    return next(
                        ApiError.BadRequest("newLogin formati noto'g'ri (3-64 belgi)")
                    );
                }
                if (normalizedLogin === me.U_login) {
                    return next(ApiError.BadRequest('Yangi login eskisi bilan bir xil'));
                }
                const dup = await fetchOslp({ login: normalizedLogin });
                if (dup.some((r) => Number(r.SlpCode) !== slpCode)) {
                    return next(ApiError.BadRequest('Bu login band'));
                }
            }

            if (wantsPassword) {
                if (typeof newPassword !== 'string' || newPassword.length < 4) {
                    return next(ApiError.BadRequest('newPassword kamida 4 ta belgi'));
                }
                if (typeof passwordConfirm !== 'string' || newPassword !== passwordConfirm) {
                    return next(ApiError.BadRequest('Parollar mos kelmaydi'));
                }
                if (newPassword === me.U_password) {
                    return next(ApiError.BadRequest('Yangi parol eskisi bilan bir xil'));
                }
            }

            await otpService.verifyOtp({ slpCode, purpose, code });

            const body = {};
            const changed = [];
            if (wantsLogin) {
                body.U_login = normalizedLogin;
                changed.push('login');
            }
            if (wantsPassword) {
                body.U_password = newPassword;
                changed.push('password');
            }

            await slPatch(`/SalesPersons(${slpCode})`, body);

            return res.json({ message: 'Muvaffaqiyatli yangilandi', changed });
        } catch (e) {
            if (e.status) return next(new ApiError(e.status, e.message));
            return next(e);
        }
    };

    // ===== PUBLIC: forgot/register OTP request (no token) =====
    requestForgotOtp = async (req, res, next) => {
        try {
            const { phone } = req.body || {};
            const normalized = normalizePhone(phone);
            if (!normalized) return next(ApiError.BadRequest("phone noto'g'ri formatda"));

            const rows = await fetchOslp({ phone: normalized });
            if (!rows.length) {
                return next(ApiError.BadRequest('Bu raqam SAP profilida topilmadi'));
            }
            if (rows.length > 1) {
                return next(
                    ApiError.BadRequest("Bu raqam bir necha profilga bog'langan. Admin bilan bog'laning.")
                );
            }
            const me = rows[0];
            const slpCode = Number(me.SlpCode);

            const profile = await SalesPersonProfile.findOne({ slpCode }).lean();
            if (profile?.isDeleted) {
                return next(ApiError.BadRequest("Akkaunt o'chirilgan"));
            }
            if (profile && profile.isActive === false) {
                return next(ApiError.BadRequest('Akkaunt aktiv emas'));
            }

            const result = await otpService.sendOtp({
                slpCode,
                phone: me.Mobil || me.Telephone || normalized,
                purpose: 'reset_password',
            });

            return res.json({
                message: "Tasdiqlash kodi Telegram orqali jo'natildi",
                ...result,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ===== PUBLIC: reset password (no token) =====
    resetPassword = async (req, res, next) => {
        try {
            const { phone, code, newPassword, passwordConfirm } = req.body || {};

            const normalized = normalizePhone(phone);
            if (!normalized) return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            if (!code) return next(ApiError.BadRequest('OTP kod majburiy'));
            if (typeof newPassword !== 'string' || newPassword.length < 4) {
                return next(ApiError.BadRequest('newPassword kamida 4 ta belgi'));
            }
            if (typeof passwordConfirm !== 'string' || newPassword !== passwordConfirm) {
                return next(ApiError.BadRequest('Parollar mos kelmaydi'));
            }

            const rows = await fetchOslp({ phone: normalized });
            if (!rows.length || rows.length > 1) {
                return next(ApiError.BadRequest("Profil topilmadi yoki bir necha profil bog'langan"));
            }
            const me = rows[0];
            const slpCode = Number(me.SlpCode);

            if (newPassword === me.U_password) {
                return next(ApiError.BadRequest('Yangi parol eskisi bilan bir xil'));
            }

            await otpService.verifyOtp({ slpCode, purpose: 'reset_password', code });

            await slPatch(`/SalesPersons(${slpCode})`, { U_password: newPassword });

            return res.json({
                message: "Parol muvaffaqiyatli o'rnatildi. /login orqali kiring.",
                slpCode,
                login: me.U_login,
            });
        } catch (e) {
            if (e.status) return next(new ApiError(e.status, e.message));
            return next(e);
        }
    };

    // ===== ADMIN: deactivate (Mongo) =====
    deactivate = async (req, res, next) => {
        try {
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }
            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            if (Number(req.user?.SlpCode) === slpCode) {
                return next(ApiError.BadRequest("O'zingizni o'chira/aktivsiz qila olmaysiz"));
            }

            const profile = await ensureProfile(slpCode);
            if (profile.isDeleted) {
                return next(ApiError.BadRequest("Akkaunt allaqachon o'chirilgan"));
            }
            profile.isActive = false;
            profile.deactivatedAt = new Date();
            profile.deactivatedBy = Number(req.user?.SlpCode) || null;
            await profile.save();

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== ADMIN: activate (Mongo) =====
    activate = async (req, res, next) => {
        try {
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }
            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const profile = await ensureProfile(slpCode);
            if (profile.isDeleted) {
                return next(
                    ApiError.BadRequest("Avval akkauntni tiklash kerak (POST /restore)")
                );
            }
            profile.isActive = true;
            profile.deactivatedAt = null;
            profile.deactivatedBy = null;
            await profile.save();

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            return next(e);
        }
    };

    // ===== CEO/Manager: soft delete (Mongo) =====
    softDelete = async (req, res, next) => {
        try {
            if (!canDeleteReq(req)) {
                return next(new ApiError(403, "O'chirish faqat CEO va Manager huquqida"));
            }
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }
            if (Number(req.user?.SlpCode) === slpCode) {
                return next(ApiError.BadRequest("O'zingizni o'chira olmaysiz"));
            }

            const rows = await fetchOslp({ slpCode });
            if (!rows.length) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const profile = await ensureProfile(slpCode);
            if (profile.isDeleted) {
                return next(ApiError.BadRequest("Akkaunt allaqachon o'chirilgan"));
            }
            profile.isDeleted = true;
            profile.isActive = false;
            profile.deletedAt = new Date();
            profile.deletedBy = Number(req.user?.SlpCode) || null;
            await profile.save();

            return res.json({
                data: { slpCode, isDeleted: true, deletedAt: profile.deletedAt },
            });
        } catch (e) {
            return next(e);
        }
    };

    // ===== CEO/Manager: restore =====
    restore = async (req, res, next) => {
        try {
            if (!canDeleteReq(req)) {
                return next(new ApiError(403, "Tiklash faqat CEO va Manager huquqida"));
            }
            const slpCode = Number(req.params.slpCode);
            if (!Number.isFinite(slpCode)) {
                return next(ApiError.BadRequest("slpCode noto'g'ri"));
            }

            const profile = await SalesPersonProfile.findOne({ slpCode });
            if (!profile || !profile.isDeleted) {
                return next(ApiError.BadRequest("Akkaunt o'chirilgan emas"));
            }
            profile.isDeleted = false;
            profile.deletedAt = null;
            profile.deletedBy = null;
            profile.isActive = true;
            await profile.save();

            const fresh = await fetchOslp({ slpCode });
            const [row] = await attachProfile(fresh);
            return res.json({ data: publicViewKeepPassword(row) });
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = new SapUserController();
module.exports.ADMIN_ROLES = ADMIN_ROLES;
module.exports.ROLE_CHANGE_ROLES = ROLE_CHANGE_ROLES;
module.exports.DELETE_ROLES = DELETE_ROLES;
