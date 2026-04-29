const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1SL1 = require('../controllers/b1SL1');
const b1HANA = require('../controllers/b1HANA');
const leadController = require('../controllers/leadController');
const analyticsController = require('../controllers/analyticsController');
const legalDocumentController = require('../controllers/legalController');
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
const {purchasePdfBasicAuth} = require("../middlewares/basic-auth-purchase-pdf");
const {webLeadBasicAuth} = require("../middlewares/basic-auth-web");
const verifyCodeController = require("../controllers/verification-controller");
const forceRefreshController = require("../controllers/forceRefreshController");
const reservationController = require("../controllers/reservationController");
const planController = require("../controllers/planController");
const roleMiddleware = require("../middlewares/role-middleware");

const appUserController = require("../controllers/app-user-controller");
const roleController = require("../controllers/role-controller");
const {
    appAuthMiddleware,
    appRoleGuard,
} = require("../middlewares/app-auth-middleware");

const ADMIN_ROLES = ['CEO', 'Manager', 'Admin'];

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('Faqat rasm yuklash mumkin (jpg, jpeg, png, webp)'));
        }
        cb(null, true);
    },
});

router.post('/login', b1HANA.login);

// === App users (SAP'dan mustaqil) ===
router.post('/auth/app/login', appUserController.login);
router.post('/auth/app/register/otp', appUserController.requestRegisterOtp);
router.post('/auth/app/register', appUserController.completeRegister);
router.post('/auth/app/forgot/otp', appUserController.requestForgotPasswordOtp);
router.post('/auth/app/forgot/reset', appUserController.resetPassword);

// Self
router.get('/me', appAuthMiddleware, appUserController.me);
router.patch('/me', appAuthMiddleware, appUserController.updateMe);
router.post('/me/avatar', appAuthMiddleware, avatarUpload.single('avatar'), appUserController.uploadMyAvatar);
router.post('/me/credentials/otp', appAuthMiddleware, appUserController.requestCredentialsOtp);
router.patch('/me/credentials', appAuthMiddleware, appUserController.changeCredentials);

// Admin: users
router.get('/users', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), appUserController.list);
router.get('/users/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), appUserController.getOne);
router.post(
    '/users',
    appAuthMiddleware,
    appRoleGuard(ADMIN_ROLES),
    avatarUpload.single('avatar'),
    appUserController.create
);
router.patch('/users/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), appUserController.update);
router.delete('/users/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), appUserController.remove);
router.post(
    '/users/:id/avatar',
    appAuthMiddleware,
    appRoleGuard(ADMIN_ROLES),
    avatarUpload.single('avatar'),
    appUserController.uploadAvatarForUser
);

// Admin: roles
router.get('/roles', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), roleController.list);
router.get('/roles/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), roleController.getOne);
router.post('/roles', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), roleController.create);
router.patch('/roles/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), roleController.update);
router.delete('/roles/:id', appAuthMiddleware, appRoleGuard(ADMIN_ROLES), roleController.remove);

router.post(
    '/webhooks/onlinepbx',
    b1HANA.onlinePbxWebhook
);

router.get(
    "/audio/:id/chats/recordings/:uuid.mp3",
    b1HANA.getChatRecording
);

router.post(
    '/legal-documents/upload',
    authMiddleware,
    upload.single('file'),
    legalDocumentController.uploadLegalDocument
);

router.get(
    '/legal-documents',
    legalDocumentController.getLegalDocuments
);

router.get(
    '/legal-documents/download/:documentId',
    legalDocumentController.downloadLegalDocument
);

router.delete(
    '/legal-documents/multiple',
    authMiddleware,
    legalDocumentController.deleteMultipleLegalDocuments
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


router.post('/send-verification-code', authMiddleware, verifyCodeController.sendVerificationCode);


router.get('/leads/:id', authMiddleware, leadController.leadOne)

router.post(
    '/leads/telegram-bot',
    telegramBotBasicAuth,
    imageUpload.array('files', 10),
    b1HANA.createLeadFromTelegramBotWithImage
);

router.post(
    '/leads/web',
    webLeadBasicAuth,
    b1HANA.createLeadFromWeb
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
    '/purchase/pdf/lead/:leadId',
    authMiddleware,
    purchasePdfController.getPurchasePdfsByLeadId
);

router.get(
    '/public/purchases/pdfs/:docNum',
    purchasePdfController.downloadPurchasePdfByDocNum
);

router.get(
    '/basic/purchases/pdfs/:docNum',
    purchasePdfBasicAuth,
    purchasePdfController.downloadPurchasePdfBasicAuth
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

router.get('/analytics/operators', authMiddleware, analyticsController.getOperatorPerformance);
router.get('/analytics/source-performance', authMiddleware, analyticsController.getSourcePerformance);
router.get('/analytics/statuses', authMiddleware, analyticsController.getGeneralStatusStats);
router.get('/analytics/sources', authMiddleware, analyticsController.getSourceDailyStats);
router.get('/analytics/source-distribution', authMiddleware, analyticsController.getSourceStatusDistribution);
router.get('/analytics/branches', authMiddleware, analyticsController.getBranchPerformance);
router.get('/analytics/branch-sources', authMiddleware, analyticsController.getBranchSourceStats);
router.get('/analytics/funnel',       authMiddleware,         analyticsController.getFullFunnelAnalytics);
router.get('/analytics/recall-date-stats', authMiddleware, analyticsController.getRecallDateStats);

router.post('/analytics/plan', authMiddleware, roleMiddleware(['CEO', 'Manager']), planController.upsertPlan);
router.get('/analytics/plan',  authMiddleware, planController.getPlan);
router.post('/leads/:id/chat', authMiddleware, b1HANA.addChat);
router.get('/leads/:id/chat', authMiddleware, b1HANA.getChats);
router.put('/leads/chat/:chatId', authMiddleware, b1HANA.updateChat);
router.delete('/leads/chat/:chatId', authMiddleware, b1HANA.deleteChat);


router.post('/reservations', authMiddleware, reservationController.createReservation);
router.delete('/reservations/:id', authMiddleware, reservationController.deleteReservation);
router.get('/reservations/lead/:leadId', authMiddleware, reservationController.getReservationsByLead);
router.get('/reservations', authMiddleware, reservationController.listReservations);

router.post('/force-refresh/user', authMiddleware, forceRefreshController.setForUser);
router.post('/force-refresh/all', authMiddleware, forceRefreshController.setForAll);

router.get('/test', (req, res) => {
    res.json({ message: 'ok' });
});
module.exports = router
