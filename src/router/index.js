const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const googleSheetWebhook = require('./googleSheetWebhook');

const router = new Router();

const invoiceRouter = require("./invoice")

router.post('/login', b1HANA.login);

router.use('/api/v1/google-sheet', googleSheetWebhook);

router.get('/executors', authMiddleware, b1HANA.executors)

router.get('/branches', authMiddleware, b1HANA.findAllBranch)

router.get('/rate', authMiddleware, b1HANA.getRate)

router.get('/leads', authMiddleware, b1HANA.leads)

router.get('/leads/:id', authMiddleware, b1HANA.leadOne)

router.put('/leads/:id', authMiddleware, b1HANA.updateLead)

router.use('/invoice', invoiceRouter);

router.get('/search', authMiddleware, b1HANA.search);

router.post('/incomingPayment', authMiddleware, b1SL.postIncomingPayment);


module.exports = router
