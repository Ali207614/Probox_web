'use strict';

/**
 * Birinchi admin va default rollarni yaratish.
 *
 *   node src/seed/seedAppUsers.js
 *
 * .env da quyidagilar bo'lishi shart:
 *   APP_BOOTSTRAP_LOGIN=admin
 *   APP_BOOTSTRAP_PASSWORD=StrongPass!
 *   APP_BOOTSTRAP_FULLNAME="Bosh Admin"
 *   APP_BOOTSTRAP_PHONE=998901234567
 */

require('dotenv').config();
const mongoose = require('mongoose');

const RoleModel = require('../models/role-model');
const AppUserModel = require('../models/app-user-model');
const { hashPassword } = require('../services/app-auth.service');

const DEFAULT_ROLES = [
    { code: 'CEO', name: 'CEO', isSystem: true },
    { code: 'Manager', name: 'Manager', isSystem: true },
    { code: 'Admin', name: 'Administrator', isSystem: true },
    { code: 'HeadOfDepartment', name: "Bo'lim boshlig'i", isSystem: false },
    { code: 'Operator', name: 'Operator', isSystem: false },
    { code: 'Operator1', name: 'Operator 1', isSystem: false },
    { code: 'Operator2', name: 'Operator 2', isSystem: false },
    { code: 'OperatorM', name: 'Operator Manager', isSystem: false },
    { code: 'Seller', name: 'Sotuvchi', isSystem: false },
    { code: 'SellerM', name: 'Sotuvchi Manager', isSystem: false },
];

(async () => {
    try {
        const dbUrl = process.env.DB_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/probox';
        await mongoose.connect(dbUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('🟢 MongoDB connected.');

        for (const r of DEFAULT_ROLES) {
            const existing = await RoleModel.findOne({ code: r.code });
            if (existing) {
                console.log(`↺  Role mavjud: ${r.code}`);
                continue;
            }
            await RoleModel.create({ ...r, isActive: true });
            console.log(`✅ Role yaratildi: ${r.code}`);
        }

        const {
            APP_BOOTSTRAP_LOGIN,
            APP_BOOTSTRAP_PASSWORD,
            APP_BOOTSTRAP_FULLNAME,
            APP_BOOTSTRAP_PHONE,
        } = process.env;

        if (!APP_BOOTSTRAP_LOGIN || !APP_BOOTSTRAP_PASSWORD || !APP_BOOTSTRAP_PHONE) {
            console.log('ℹ️  Bootstrap admin uchun .env to\'ldirilmagan — qadam o\'tkazib yuborildi.');
            await mongoose.disconnect();
            return;
        }

        const login = String(APP_BOOTSTRAP_LOGIN).toLowerCase().trim();
        const phone = String(APP_BOOTSTRAP_PHONE).replace(/\D/g, '');

        const existingAdmin = await AppUserModel.findOne({
            $or: [{ login }, { phone }],
        }).lean();

        if (existingAdmin) {
            console.log(`↺  Bootstrap admin allaqachon mavjud (login=${existingAdmin.login}).`);
        } else {
            const adminRole = await RoleModel.findOne({ code: 'Admin' }).lean();
            const passwordHash = await hashPassword(APP_BOOTSTRAP_PASSWORD);
            await AppUserModel.create({
                fullName: APP_BOOTSTRAP_FULLNAME || 'Bosh Admin',
                phone,
                login,
                passwordHash,
                role: adminRole._id,
                isActive: true,
                isRegistered: true,
                registeredAt: new Date(),
            });
            console.log(`✅ Bootstrap admin yaratildi: login=${login}, phone=${phone}`);
        }

        await mongoose.disconnect();
        console.log('🔌 MongoDB connection closed.');
    } catch (err) {
        console.error('❌ Seed xatosi:', err);
        process.exit(1);
    }
})();
