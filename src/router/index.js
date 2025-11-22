const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const leadController = require('../controllers/leadController');
const analyticsController = require('../controllers/analyticsController');
const authMiddleware = require('../middlewares/auth-middleware');
const googleSheetWebhook = require('./googleSheetWebhook');

const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const router = new Router();

const invoiceRouter = require("./invoice")

router.post('/login', b1HANA.login);

router.use('/google-sheet', googleSheetWebhook);

router.get('/executors', authMiddleware, b1HANA.executors)

router.get('/items', authMiddleware, b1HANA.getItems)

router.get('/item-series', authMiddleware, b1HANA.getItemSeries)

router.get('/branches', authMiddleware, b1HANA.findAllBranch)

router.get('/rate', authMiddleware, b1HANA.getRate)

router.get('/leads', authMiddleware, b1HANA.leads)

router.get('/leads/:id', authMiddleware, leadController.leadOne)

// ==========================
//     LEAD IMAGES API
// ==========================

// Rasm yuklash (3-size)
router.post(
    '/lead-images/upload',
    authMiddleware,
    upload.single('image'),
    leadController.uploadLeadImage
);

// Leadga tegishli rasmlarni olish (3-size signed URL bilan)
router.get(
    '/lead-images/:leadId',
    authMiddleware,
    leadController.getLeadImages
);

// LeadImage o‘chirish (3-size rasm o‘chadi)
router.delete(
    '/lead-images/:id',
    authMiddleware,
    leadController.deleteLeadImage
);



router.post('/create/invoice', authMiddleware, b1SL.createInvoice);

router.put('/leads/:id', authMiddleware, b1HANA.updateLead)

router.use('/invoice', invoiceRouter);

router.get('/search', authMiddleware, b1HANA.search);

router.post('/incomingPayment', authMiddleware, b1SL.postIncomingPayment);

router.post('/leads', authMiddleware, b1HANA.createLead);

router.get('/lead-analytics', authMiddleware, analyticsController.getLeadsAnalytics);

router.post('/leads/:id/chat', authMiddleware, b1HANA.addChat);
router.get('/leads/:id/chat', authMiddleware, b1HANA.getChats);
router.patch('/leads/chat/:chatId', authMiddleware, b1HANA.updateChat);
router.delete('/leads/chat/:chatId', authMiddleware, b1HANA.deleteChat);


router.get('/test', (req, res) => {
    res.json({ message: 'ok' });
});
module.exports = router
