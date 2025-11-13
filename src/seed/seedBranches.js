const mongoose = require('mongoose');
const Branch = require('../models/branch-model'); // kerakli yo‘lni moslang
require('dotenv').config();
(async () => {
    try {
        // === 1️⃣ MongoDB ga ulanish
        await mongoose.connect(process.env.DB_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });

        console.log('🟢 MongoDB connected.');


        await Branch.deleteMany({});


        // === 3️⃣ Yangi filiallarni qo‘shamiz
        const branches = [
            { id: 1, code:'02', name: 'Qoratosh', region: 'Toshkent', address: 'Qoratosh ko‘chasi', phone: '+998901111111' },
            { id: 2, code:'01', name: 'Sag‘bon', region: 'Toshkent', address: 'Sag‘bon ko‘chasi', phone: '+998902222222' },
            { id: 3, code:'04', name: 'Parkent', region: 'Toshkent', address: 'Parkent ko‘chasi', phone: '+998903333333' },
        ];

        const inserted = await Branch.insertMany(branches);
        console.log(`✅ ${inserted.length} ta filial qo‘shildi:`);
        console.table(inserted.map(b => ({ id: b.id, name: b.name })));

        // === 4️⃣ Tugatamiz
        await mongoose.disconnect();
        console.log('🔌 MongoDB connection closed.');
    } catch (err) {
        console.error('❌ Seed xatosi:', err);
        process.exit(1);
    }
})();
