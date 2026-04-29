'use strict';

const mongoose = require('mongoose');

const RoleModel = require('../models/role-model');
const AppUserModel = require('../models/app-user-model');
const ApiError = require('../exceptions/api-error');

function normalizeCode(raw) {
    return String(raw || '').trim().replace(/[^A-Za-z0-9_]/g, '');
}

class RoleController {
    list = async (req, res, next) => {
        try {
            const { search, isActive } = req.query;
            const filter = {};

            if (typeof isActive !== 'undefined') {
                filter.isActive = String(isActive) === 'true';
            }
            if (search) {
                const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                filter.$or = [
                    { code: { $regex: safe, $options: 'i' } },
                    { name: { $regex: safe, $options: 'i' } },
                ];
            }

            const roles = await RoleModel.find(filter).sort({ name: 1 }).lean();
            return res.json({ data: roles });
        } catch (e) {
            return next(e);
        }
    };

    getOne = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }
            const role = await RoleModel.findById(id).lean();
            if (!role) return next(ApiError.BadRequest('Role topilmadi'));
            return res.json({ data: role });
        } catch (e) {
            return next(e);
        }
    };

    create = async (req, res, next) => {
        try {
            const { code, name, description, isActive } = req.body || {};
            if (!code || !name) {
                return next(ApiError.BadRequest('code va name majburiy'));
            }

            const normalized = normalizeCode(code);
            if (!/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(normalized)) {
                return next(ApiError.BadRequest("code formati noto'g'ri (harfdan boshlanadi, A-Z a-z 0-9 _)"));
            }

            const exists = await RoleModel.findOne({ code: normalized }).lean();
            if (exists) {
                return next(ApiError.BadRequest('Bu code allaqachon mavjud'));
            }

            const role = await RoleModel.create({
                code: normalized,
                name: String(name).trim(),
                description: description ? String(description).trim() : null,
                isActive: isActive !== false,
            });

            return res.status(201).json({ data: role });
        } catch (e) {
            if (e?.code === 11000) {
                return next(ApiError.BadRequest('Bu code allaqachon mavjud'));
            }
            return next(e);
        }
    };

    update = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }

            const role = await RoleModel.findById(id);
            if (!role) return next(ApiError.BadRequest('Role topilmadi'));

            const { name, description, isActive, code } = req.body || {};

            if (typeof name === 'string' && name.trim()) {
                role.name = name.trim();
            }
            if (typeof description !== 'undefined') {
                role.description = description ? String(description).trim() : null;
            }
            if (typeof isActive === 'boolean') {
                role.isActive = isActive;
            }
            if (typeof code === 'string' && !role.isSystem) {
                const normalized = normalizeCode(code);
                if (!/^[A-Za-z][A-Za-z0-9_]{1,31}$/.test(normalized)) {
                    return next(ApiError.BadRequest("code formati noto'g'ri"));
                }
                if (normalized !== role.code) {
                    const dup = await RoleModel.findOne({ code: normalized, _id: { $ne: role._id } }).lean();
                    if (dup) return next(ApiError.BadRequest('Bu code allaqachon mavjud'));
                    role.code = normalized;
                }
            }

            await role.save();
            return res.json({ data: role });
        } catch (e) {
            if (e?.code === 11000) {
                return next(ApiError.BadRequest('Bu code allaqachon mavjud'));
            }
            return next(e);
        }
    };

    remove = async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return next(ApiError.BadRequest("id noto'g'ri"));
            }

            const role = await RoleModel.findById(id);
            if (!role) return next(ApiError.BadRequest('Role topilmadi'));
            if (role.isSystem) {
                return next(ApiError.BadRequest("Tizim roli o'chirib bo'lmaydi"));
            }

            const inUse = await AppUserModel.exists({ role: role._id });
            if (inUse) {
                return next(
                    ApiError.BadRequest(
                        "Bu role foydalanuvchilarga biriktirilgan. Avval ularni boshqa rolga o'tkazing."
                    )
                );
            }

            await role.deleteOne();
            return res.json({ data: { id: role._id, deleted: true } });
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = new RoleController();
