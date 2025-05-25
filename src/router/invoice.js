const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const upload = require('../middlewares/uploadMiddleware');
const router = new Router();


router.get('/', authMiddleware, b1HANA.invoice);
router.get('/report', authMiddleware, b1HANA.getAnalytics)
router.get('/report-days', authMiddleware, b1HANA.getAnalyticsByDay)
router.get('/:id', authMiddleware, b1HANA.getPayList);
router.put('/executor/:DocEntry/:InstlmntID', authMiddleware, b1HANA.updateExecutor);
router.put('/confiscating/:DocEntry/:InstlmntID', authMiddleware, b1HANA.confiscating);

router.get('/comments/:DocEntry/:InstlmntID', authMiddleware, b1HANA.getComments);
router.post('/comments/:DocEntry/:InstlmntID', authMiddleware, b1HANA.createComment);

router.put('/comments/:id', authMiddleware, b1HANA.updateComment);
router.delete('/comments/:id', authMiddleware, b1HANA.deleteComment);

router.put('/upload/:DocEntry/:InstlmntID', authMiddleware, upload.array('files'), b1HANA.uploadImage);
router.delete('/upload/:DocEntry/:InstlmntID/:ImageId', authMiddleware, b1HANA.deleteImage);




router.put('/distribution', authMiddleware, b1HANA.distribution);


module.exports = router
