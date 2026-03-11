const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1SL1 = require('../controllers/b1SL1');
const b1HANA = require('../controllers/b1HANA');
const leadController = require('../controllers/leadController');
const analyticsController = require('../controllers/analyticsController');
const authMiddleware = require('../middlewares/auth-middleware');
const googleSheetWebhook = require('./googleSheetWebhook');
const purchasePdfControllerFactory = require('../controllers/purchasePdfController');
const UploadService = require('../minio');

const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGE_COUNT = 10;
const ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
];

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_IMAGE_SIZE,
        files: MAX_IMAGE_COUNT,
    },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
            return cb(new Error('Faqat rasm yuklash mumkin (jpg, jpeg, png, webp)'));
        }
        cb(null, true);
    },
});



const uploadService = new UploadService();
const purchasePdfController = purchasePdfControllerFactory({ uploadService });
const router = new Router();

const invoiceRouter = require("./invoice")
const {telegramBotBasicAuth} = require("../middlewares/basic-auth-telegram");
const verifyCodeController = require("../controllers/verification-controller");

router.post('/login', b1HANA.login);

router.post(
    '/webhooks/onlinepbx',
    b1HANA.onlinePbxWebhook
);

router.get(
    "/audio/:id/chats/recordings/:uuid.mp3",
    b1HANA.getChatRecording
);

router.use('/google-sheet', googleSheetWebhook);

router.get('/executors', authMiddleware, b1HANA.executors)

router.get('/purchases', authMiddleware, b1HANA.getPurchases)

router.get('/purchases/:source/:docEntry', authMiddleware, b1HANA.getPurchaseDetail)

router.get('/items/groups', authMiddleware, b1HANA.getItemGroups);

router.get('/suppliers', authMiddleware, b1HANA.getSuppliers);


router.post('/purchases/drafts', authMiddleware, b1SL1.createPurchaseDraft)

router.patch('/purchases/drafts/:docEntry', authMiddleware, b1SL1.patchDraft)


router.post('/purchases/drafts/:docEntry/cancel', authMiddleware, b1SL1.cancelPurchaseDraft);
router.post('/purchases/drafts/:docEntry/approve', authMiddleware, b1SL1.approvePurchaseDraft_convert);


router.get('/limit/usage', authMiddleware, b1HANA.getLimitUsage)


router.get('/items', authMiddleware, b1HANA.getItems)

router.get('/item-series', authMiddleware, b1HANA.getItemSeries)

router.get('/branches', authMiddleware, b1HANA.findAllBranch)

router.get('/rate', authMiddleware, b1HANA.getRate)

router.get('/leads', authMiddleware, b1HANA.leads)

router.get('/lead-rating/:id', b1HANA.getLeadRating);

router.post('/lead-rating/:id', b1HANA.rateLead);


router.post('/send-verification-code',verifyCodeController.sendVerificationCode);


router.get('/leads/:id', authMiddleware, leadController.leadOne)

router.post(
    '/leads/telegram-bot',
    telegramBotBasicAuth,
    imageUpload.array('files', 10),
    b1HANA.createLeadFromTelegramBotWithImage
);

router.post(
    '/lead-images/upload',
    authMiddleware,
    upload.single('image'),
    leadController.uploadLeadImage
);

router.post(
    '/purchases/pdfs',
    authMiddleware,
    upload.single('file'),
    purchasePdfController.uploadPurchasePdf
);

router.get(
    '/purchase/pdf/:docEntry',
    authMiddleware,
    purchasePdfController.getPurchasePdfsByDocEntry
);

router.get(
    '/public/purchases/pdfs/:docEntry',
    purchasePdfController.downloadPurchasePdfByDocEntry
);

router.delete(
    '/purchases/pdfs/:id',
    authMiddleware,
    purchasePdfController.deletePurchasePdf
);


router.get(
    '/lead-images/:leadId',
    authMiddleware,
    leadController.getLeadImages
);


router.delete(
    '/lead-images/:id',
    authMiddleware,
    leadController.deleteLeadImage
);

router.get('/public/contracts/:key', leadController.downloadContract);


router.post('/create/invoice', authMiddleware, b1SL.createInvoiceAndPayment);
router.post('/create/invoice/test', authMiddleware, b1SL1.createInvoiceAndPayment);

router.put('/leads/:id', authMiddleware, b1HANA.updateLead)

router.use('/invoice', invoiceRouter);

router.get('/search', authMiddleware, b1HANA.search);

router.post('/incomingPayment', authMiddleware, b1SL.postIncomingPayment);

router.post('/leads', authMiddleware, b1HANA.createLead);

router.get('/lead-analytics', authMiddleware, analyticsController.getLeadsAnalytics);
router.get('/leads/analytics/funnel-by-operators', authMiddleware ,analyticsController.getLeadsFunnelByOperators);


router.post('/leads/:id/chat', authMiddleware, b1HANA.addChat);
router.get('/leads/:id/chat', authMiddleware, b1HANA.getChats);
router.put('/leads/chat/:chatId', authMiddleware, b1HANA.updateChat);
router.delete('/leads/chat/:chatId', authMiddleware, b1HANA.deleteChat);


router.get('/test', (req, res) => {
    res.json({ message: 'ok' });
});
module.exports = router
