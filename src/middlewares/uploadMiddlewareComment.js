const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Fayl saqlash va nomlash
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './uploads/comments';
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, filename);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'audio/mpeg', 'audio/mp3', 'audio/wav'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type'), false);
    }
};

const uploadComment = multer({ storage, fileFilter }); // ✅ ESENG kerak bo‘lgani mana shu


module.exports = uploadComment;