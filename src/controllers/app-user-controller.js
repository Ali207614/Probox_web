'use strict';

const mongoose = require('mongoose');

const AppUserModel = require('../models/app-user-model');
const RoleModel = require('../models/role-model');
const ApiError = require('../exceptions/api-error');
const UploadService = require('../minio');

const {
    hashPassword,
    comparePassword,
    signAppToken,
} = require('../services/app-auth.service');

const otpService = require('../services/otp.service');

const uploadService = new UploadService();

const ADMIN_ROLE_CODES = new Set(['CEO', 'Manager', 'Admin']);

function isAdmin(req) {
    return ADMIN_ROLE_CODES.has(req.appUserRoleCode || '');
}

function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 12 && digits.startsWith('998')) return digits;
    if (digits.length === 9) return '998' + digits;
    if (digits.length > 9) return '998' + digits.slice(-9);
    return null;
}

function normalizeLogin(raw) {
    return String(raw || '').trim().toLowerCase();
}

function publicUser(user) {
    if (!user) return null;
    const obj = user.toObject ? user.toObject() : { ...user };
    delete obj.passwordHash;
    return obj;
}

async function withSignedAvatar(user) {
    const obj = publicUser(user);
    if (obj?.avatar?.keys) {
        try {
            obj.avatar.urls = await uploadService.generateSignedUrls(obj.avatar.keys);
        } catch (err) {
            console.error('[AppUser] avatar signed url error:', err?.message || err);
            obj.avatar.urls = null;
        }
    }
    return obj;
}

class AppUserController {
    // ---- Auth
    login = async (req, res, next) => {
        try {
            const { login, password } = req.body || {};
            if (!login || !password) {
                return next(ApiError.BadRequest('login va password majburiy'));
            }

            const user = await AppUserModel.findOne({ login: normalizeLogin(login) })
                .select('+passwordHash')
                .populate('role', 'code name isActive');

            if (!user || !user.isActive || !user.isRegistered) {
                return next(ApiError.BadRequest("Login yoki parol noto'g'ri"));
            }
            if (user.role && user.role.isActive === false) {
                return next(ApiError.BadRequest('Sizning rolingiz aktiv emas'));
            }

            const ok = await comparePassword(password, user.passwordHash);
            if (!ok) {
                return next(ApiError.BadRequest("Login yoki parol noto'g'ri"));
            }

            user.lastLoginAt = new Date();
            await user.save();

            const token = signAppToken(user, user.role);
            const data = await withSignedAvatar(user);

            return res.status(200).json({ token, data });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Auth: 1-bosqich — phone bo'yicha OTP yuborish
    requestRegisterOtp = async (req, res, next) => {
        try {
            const { phone } = req.body || {};
            const normalized = normalizePhone(phone);
            if (!normalized) {
                return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            }

            const user = await AppUserModel.findOne({ phone: normalized }).lean();
            if (!user || !user.isActive) {
                return next(ApiError.BadRequest('Bu raqam tizimda topilmadi yoki aktiv emas'));
            }
            if (user.isRegistered) {
                return next(ApiError.BadRequest("Bu akkaunt allaqachon ro'yxatdan o'tgan. Login orqali kiring."));
            }

            const result = await otpService.sendOtp({ user, purpose: 'register' });
            return res.json({
                message: "Tasdiqlash kodi Telegram orqali jo'natildi",
                ...result,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Auth: 2-bosqich — OTP + login/parol o'rnatish va tokenni qaytarish
    completeRegister = async (req, res, next) => {
        try {
            const { phone, code, login, password, passwordConfirm } = req.body || {};

            const normalizedPhone = normalizePhone(phone);
            if (!normalizedPhone) {
                return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            }
            if (!code) return next(ApiError.BadRequest('OTP kod majburiy'));
            if (!login) return next(ApiError.BadRequest('login majburiy'));
            if (!password) return next(ApiError.BadRequest('password majburiy'));
            if (!passwordConfirm) return next(ApiError.BadRequest('passwordConfirm majburiy'));
            if (password !== passwordConfirm) {
                return next(ApiError.BadRequest('Parollar mos kelmaydi'));
            }
            if (typeof password !== 'string' || password.length < 6) {
                return next(ApiError.BadRequest("Parol kamida 6 ta belgidan iborat bo'lishi kerak"));
            }

            const normalizedLogin = normalizeLogin(login);
            if (!/^[a-z0-9._-]{3,64}$/.test(normalizedLogin)) {
                return next(ApiError.BadRequest('login formati 3-64 belgi (a-z, 0-9, ., _, -)'));
            }

            const user = await AppUserModel.findOne({ phone: normalizedPhone }).populate(
                'role',
                'code name isActive'
            );
            if (!user || !user.isActive) {
                return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));
            }
            if (user.isRegistered) {
                return next(ApiError.BadRequest("Bu akkaunt allaqachon ro'yxatdan o'tgan"));
            }

            const dup = await AppUserModel.findOne({
                login: normalizedLogin,
                _id: { $ne: user._id },
            }).lean();
            if (dup) return next(ApiError.BadRequest('Bu login band'));

            await otpService.verifyOtp({
                userId: user._id,
                purpose: 'register',
                code,
            });

            user.login = normalizedLogin;
            user.passwordHash = await hashPassword(password);
            user.isRegistered = true;
            user.registeredAt = new Date();
            user.lastLoginAt = new Date();
            await user.save();

            const token = signAppToken(user, user.role);
            const data = await withSignedAvatar(user);

            return res.status(200).json({ token, data });
        } catch (e) {
            if (e?.code === 11000) {
                return next(ApiError.BadRequest('Bu login band'));
            }
            return next(e);
        }
    };

    // ---- Admin: list
    list = async (req, res, next) => {
        try {
            const page = Math.max(parseInt(req.query.page) || 1, 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
            const skip = (page - 1) * limit;

            const { search, roleCode, isActive } = req.query;
            const filter = {};

            if (typeof isActive !== 'undefined') {
                filter.isActive = String(isActive) === 'true';
            }

            if (roleCode) {
                const role = await RoleModel.findOne({ code: String(roleCode) }).lean();
                filter.role = role ? role._id : new mongoose.Types.ObjectId();
            }

            if (search) {
                const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                filter.$or = [
                    { fullName: { $regex: safe, $options: 'i' } },
                    { login: { $regex: safe, $options: 'i' } },
                    { phone: { $regex: safe } },
                ];
            }

            const [items, total] = await Promise.all([
                AppUserModel.find(filter)
                    .populate('role', 'code name')
                    .sort({ created_at: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                AppUserModel.countDocuments(filter),
            ]);

            const data = await Promise.all(items.map((u) => withSignedAvatar(u)));

            return res.json({
                data,
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Admin: get one
    getOne = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }
            const user = await AppUserModel.findById(id)
                .populate('role', 'code name isActive')
                .lean();
            if (!user) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));
            return res.json({ data: await withSignedAvatar(user) });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Admin: create (faqat fullName + phone + roleId; login/parolni user o'zi register qiladi)
    create = async (req, res, next) => {
        try {
            const { fullName, phone, roleId, slpCode } = req.body || {};

            if (!fullName || !phone || !roleId) {
                return next(ApiError.BadRequest('fullName, phone, roleId majburiy'));
            }

            if (!mongoose.isValidObjectId(roleId)) {
                return next(ApiError.BadRequest("roleId noto'g'ri"));
            }

            const normalizedPhone = normalizePhone(phone);
            if (!normalizedPhone) {
                return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            }

            const role = await RoleModel.findById(roleId).lean();
            if (!role || role.isActive === false) {
                return next(ApiError.BadRequest('Role topilmadi yoki aktiv emas'));
            }

            const dup = await AppUserModel.findOne({ phone: normalizedPhone }).lean();
            if (dup) {
                return next(ApiError.BadRequest("Bu phone allaqachon ro'yxatdan o'tgan"));
            }

            let avatar = null;
            if (req.file) {
                const tmpId = new mongoose.Types.ObjectId();
                const uploaded = await uploadService.uploadProfilePicture(tmpId.toString(), req.file);
                avatar = { keys: uploaded.keys };
            }

            const user = await AppUserModel.create({
                fullName: String(fullName).trim(),
                phone: normalizedPhone,
                role: role._id,
                avatar,
                slpCode: slpCode != null && slpCode !== '' ? Number(slpCode) : null,
                isRegistered: false,
                createdBy: req.appUser?._id || null,
            });

            const created = await AppUserModel.findById(user._id)
                .populate('role', 'code name')
                .lean();

            return res.status(201).json({
                data: await withSignedAvatar(created),
                message:
                    "Foydalanuvchi yaratildi. U /auth/app/register/otp orqali ro'yxatdan o'tishi kerak.",
            });
        } catch (e) {
            if (e?.code === 11000) {
                const field = Object.keys(e.keyValue || {})[0] || 'field';
                return next(ApiError.BadRequest(`Bu ${field} allaqachon mavjud`));
            }
            return next(e);
        }
    };

    // ---- Admin: update (login & password EMAS)
    update = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }

            const user = await AppUserModel.findById(id);
            if (!user) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const { fullName, phone, roleId, slpCode, isActive } = req.body || {};

            if (typeof fullName === 'string' && fullName.trim()) {
                user.fullName = fullName.trim();
            }

            if (typeof phone === 'string') {
                const normalized = normalizePhone(phone);
                if (!normalized) return next(ApiError.BadRequest("phone noto'g'ri formatda"));
                if (normalized !== user.phone) {
                    const dup = await AppUserModel.findOne({ phone: normalized, _id: { $ne: user._id } }).lean();
                    if (dup) return next(ApiError.BadRequest("Bu phone allaqachon ro'yxatdan o'tgan"));
                    user.phone = normalized;
                }
            }

            if (roleId) {
                if (!mongoose.isValidObjectId(roleId)) {
                    return next(ApiError.BadRequest("roleId noto'g'ri"));
                }
                const role = await RoleModel.findById(roleId).lean();
                if (!role || role.isActive === false) {
                    return next(ApiError.BadRequest('Role topilmadi yoki aktiv emas'));
                }
                user.role = role._id;
            }

            if (typeof slpCode !== 'undefined') {
                user.slpCode = slpCode != null && slpCode !== '' ? Number(slpCode) : null;
            }

            if (typeof isActive === 'boolean') {
                user.isActive = isActive;
            }

            await user.save();

            const updated = await AppUserModel.findById(user._id)
                .populate('role', 'code name')
                .lean();

            return res.json({ data: await withSignedAvatar(updated) });
        } catch (e) {
            if (e?.code === 11000) {
                const field = Object.keys(e.keyValue || {})[0] || 'field';
                return next(ApiError.BadRequest(`Bu ${field} allaqachon mavjud`));
            }
            return next(e);
        }
    };

    // ---- Admin: soft delete
    remove = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }

            const user = await AppUserModel.findById(id);
            if (!user) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            if (req.appUser && String(req.appUser._id) === String(user._id)) {
                return next(ApiError.BadRequest("O'zingizni o'chira olmaysiz"));
            }

            user.isActive = false;
            await user.save();
            return res.json({ data: { id: user._id, deactivated: true } });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Admin: avatar upload (other users)
    uploadAvatarForUser = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }
            if (!req.file) return next(ApiError.BadRequest('Fayl yuklanmadi'));

            const user = await AppUserModel.findById(id);
            if (!user) return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));

            const oldKeys = user.avatar?.keys
                ? Object.values(user.avatar.keys).filter(Boolean)
                : [];

            const uploaded = await uploadService.uploadProfilePicture(user._id.toString(), req.file);
            user.avatar = { keys: uploaded.keys };
            await user.save();

            if (oldKeys.length) {
                uploadService.deleteImages(oldKeys).catch((err) =>
                    console.error('[AppUser] eski avatar o\'chirishda xatolik:', err?.message || err)
                );
            }

            const populated = await AppUserModel.findById(user._id)
                .populate('role', 'code name')
                .lean();
            return res.json({ data: await withSignedAvatar(populated) });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Self: /me
    me = async (req, res, next) => {
        try {
            const user = await AppUserModel.findById(req.appUser._id)
                .populate('role', 'code name isActive')
                .lean();
            if (!user) return next(ApiError.UnauthorizedError());
            return res.json({ data: await withSignedAvatar(user) });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Self: update profile (faqat fullName + avatar)
    updateMe = async (req, res, next) => {
        try {
            const user = await AppUserModel.findById(req.appUser._id);
            if (!user) return next(ApiError.UnauthorizedError());

            const { fullName } = req.body || {};
            if (typeof fullName === 'string' && fullName.trim()) {
                user.fullName = fullName.trim();
            }

            await user.save();

            const populated = await AppUserModel.findById(user._id)
                .populate('role', 'code name')
                .lean();
            return res.json({ data: await withSignedAvatar(populated) });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Self: avatar upload
    uploadMyAvatar = async (req, res, next) => {
        try {
            if (!req.file) return next(ApiError.BadRequest('Fayl yuklanmadi'));

            const user = await AppUserModel.findById(req.appUser._id);
            if (!user) return next(ApiError.UnauthorizedError());

            const oldKeys = user.avatar?.keys
                ? Object.values(user.avatar.keys).filter(Boolean)
                : [];

            const uploaded = await uploadService.uploadProfilePicture(user._id.toString(), req.file);
            user.avatar = { keys: uploaded.keys };
            await user.save();

            if (oldKeys.length) {
                uploadService.deleteImages(oldKeys).catch((err) =>
                    console.error('[AppUser] eski avatar o\'chirishda xatolik:', err?.message || err)
                );
            }

            const populated = await AppUserModel.findById(user._id)
                .populate('role', 'code name')
                .lean();
            return res.json({ data: await withSignedAvatar(populated) });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Self: OTP request
    //   purpose: 'change_login' | 'change_password' | 'change_credentials'
    //   change_credentials  → bitta OTP bilan login va parolni birga almashtirish
    requestCredentialsOtp = async (req, res, next) => {
        try {
            const { purpose } = req.body || {};
            if (!['change_login', 'change_password', 'change_credentials'].includes(purpose)) {
                return next(ApiError.BadRequest("purpose noto'g'ri"));
            }

            const user = await AppUserModel.findById(req.appUser._id).lean();
            if (!user || !user.isActive) return next(ApiError.UnauthorizedError());

            const result = await otpService.sendOtp({ user, purpose });
            return res.json({
                message: "Tasdiqlash kodi Telegram orqali jo'natildi",
                ...result,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Self: change credentials with OTP
    //   change_login        → newLogin majburiy
    //   change_password     → newPassword majburiy
    //   change_credentials  → newLogin yoki newPassword (yoki ikkalasi) majburiy
    //   Joriy parol so'ralmaydi — OTP ikkinchi faktor sifatida yetarli.
    changeCredentials = async (req, res, next) => {
        try {
            const { purpose, code, newLogin, newPassword, passwordConfirm } = req.body || {};

            if (!['change_login', 'change_password', 'change_credentials'].includes(purpose)) {
                return next(ApiError.BadRequest("purpose noto'g'ri"));
            }
            if (!code) return next(ApiError.BadRequest('OTP kod majburiy'));

            const wantsLogin = purpose === 'change_login' || (purpose === 'change_credentials' && newLogin);
            const wantsPassword = purpose === 'change_password' || (purpose === 'change_credentials' && newPassword);

            if (purpose === 'change_login' && !newLogin) {
                return next(ApiError.BadRequest('newLogin majburiy'));
            }
            if (purpose === 'change_password' && !newPassword) {
                return next(ApiError.BadRequest('newPassword majburiy'));
            }
            if (purpose === 'change_credentials' && !wantsLogin && !wantsPassword) {
                return next(ApiError.BadRequest('newLogin yoki newPassword (yoki ikkalasi) majburiy'));
            }

            const user = await AppUserModel.findById(req.appUser._id).select('+passwordHash');
            if (!user || !user.isActive) return next(ApiError.UnauthorizedError());

            // Validatsiya — OTP'ni iste'mol qilishdan oldin
            let normalizedLogin = null;
            if (wantsLogin) {
                normalizedLogin = normalizeLogin(newLogin);
                if (!/^[a-z0-9._-]{3,64}$/.test(normalizedLogin)) {
                    return next(ApiError.BadRequest("newLogin formati noto'g'ri (3-64, a-z 0-9 . _ -)"));
                }
                if (normalizedLogin === user.login) {
                    return next(ApiError.BadRequest('Yangi login eskisi bilan bir xil'));
                }
                const dup = await AppUserModel.findOne({
                    login: normalizedLogin,
                    _id: { $ne: user._id },
                }).lean();
                if (dup) return next(ApiError.BadRequest('Bu login band'));
            }

            if (wantsPassword) {
                if (typeof newPassword !== 'string' || newPassword.length < 6) {
                    return next(ApiError.BadRequest("newPassword kamida 6 ta belgi"));
                }
                if (typeof passwordConfirm !== 'string' || newPassword !== passwordConfirm) {
                    return next(ApiError.BadRequest('Parollar mos kelmaydi'));
                }
                if (user.passwordHash && (await comparePassword(newPassword, user.passwordHash))) {
                    return next(ApiError.BadRequest('Yangi parol eskisi bilan bir xil'));
                }
            }

            await otpService.verifyOtp({
                userId: user._id,
                purpose,
                code,
            });

            const changed = [];
            if (wantsLogin) {
                user.login = normalizedLogin;
                changed.push('login');
            }
            if (wantsPassword) {
                user.passwordHash = await hashPassword(newPassword);
                changed.push('password');
            }

            await user.save();
            return res.json({
                message: 'Muvaffaqiyatli yangilandi',
                changed,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Auth: parolni unutgan — phone bo'yicha OTP yuborish (token shart emas)
    requestForgotPasswordOtp = async (req, res, next) => {
        try {
            const { phone } = req.body || {};
            const normalized = normalizePhone(phone);
            if (!normalized) {
                return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            }

            const user = await AppUserModel.findOne({ phone: normalized }).lean();
            if (!user || !user.isActive) {
                return next(ApiError.BadRequest('Bu raqam tizimda topilmadi yoki aktiv emas'));
            }
            if (!user.isRegistered) {
                return next(
                    ApiError.BadRequest(
                        "Avval ro'yxatdan o'ting: /auth/app/register/otp"
                    )
                );
            }

            const result = await otpService.sendOtp({ user, purpose: 'reset_password' });
            return res.json({
                message: "Tasdiqlash kodi Telegram orqali jo'natildi",
                ...result,
            });
        } catch (e) {
            return next(e);
        }
    };

    // ---- Auth: parolni tiklash (token shart emas)
    resetPassword = async (req, res, next) => {
        try {
            const { phone, code, newPassword, passwordConfirm } = req.body || {};

            const normalizedPhone = normalizePhone(phone);
            if (!normalizedPhone) {
                return next(ApiError.BadRequest("phone noto'g'ri formatda"));
            }
            if (!code) return next(ApiError.BadRequest('OTP kod majburiy'));
            if (typeof newPassword !== 'string' || newPassword.length < 6) {
                return next(ApiError.BadRequest("newPassword kamida 6 ta belgi"));
            }
            if (typeof passwordConfirm !== 'string' || newPassword !== passwordConfirm) {
                return next(ApiError.BadRequest('Parollar mos kelmaydi'));
            }

            const user = await AppUserModel.findOne({ phone: normalizedPhone })
                .select('+passwordHash')
                .populate('role', 'code name isActive');

            if (!user || !user.isActive) {
                return next(ApiError.BadRequest('Foydalanuvchi topilmadi'));
            }
            if (!user.isRegistered) {
                return next(ApiError.BadRequest("Akkaunt ro'yxatdan o'tmagan"));
            }

            if (user.passwordHash && (await comparePassword(newPassword, user.passwordHash))) {
                return next(ApiError.BadRequest('Yangi parol eskisi bilan bir xil'));
            }

            await otpService.verifyOtp({
                userId: user._id,
                purpose: 'reset_password',
                code,
            });

            user.passwordHash = await hashPassword(newPassword);
            user.lastLoginAt = new Date();
            await user.save();

            const token = signAppToken(user, user.role);
            const data = await withSignedAvatar(user);
            return res.status(200).json({ token, data });
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = new AppUserController();
module.exports.isAdmin = isAdmin;
module.exports.ADMIN_ROLE_CODES = ADMIN_ROLE_CODES;
