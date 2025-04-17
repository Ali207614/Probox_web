const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const upload = require('../middlewares/uploadMiddleware');
const router = new Router();


router.get('/', authMiddleware, b1HANA.invoice);
router.get('/:id', authMiddleware, b1HANA.getPayList);
router.put('/upload/:DocEntry/:InstlmntID', authMiddleware, upload.single('file'), b1HANA.uploadImage);
router.delete('/upload/:DocEntry/:InstlmntID/:ImageId', authMiddleware, b1HANA.deleteImage);




router.put('/distribution', authMiddleware, b1HANA.distribution);


module.exports = router
