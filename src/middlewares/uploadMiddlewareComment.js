const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, filename);
    }
});

// Ruxsat berilgan MIME turlar
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg','image/jpg', 'image/png', 'audio/mpeg', 'audio/mp3', 'audio/wav','audio/m4a'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type'), false);
    }
};

// Multer instance
const upload = multer({ storage, fileFilter });

module.exports = upload; // 👈 `uploadComment` emas, to‘g‘ridan-to‘g‘ri multer instance
