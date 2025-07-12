// middlewares/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const { DocEntry, InstlmntID } = req.params;
        const ext = path.extname(file.originalname).toLowerCase();
        const newFileName = `${DocEntry}-${InstlmntID}-${Date.now()}${ext}`;
        cb(null, newFileName);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|xlsx|xls/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.test(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Only images, PDFs, and Excel files are allowed!'), false);
    }
};

const upload = multer({
    storage,
    fileFilter
});

module.exports = upload;
