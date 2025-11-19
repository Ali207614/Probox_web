const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const googleSheetWebhook = require('./googleSheetWebhook');

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

router.get('/leads/:id', authMiddleware, b1HANA.leadOne)

router.put('/leads/:id', authMiddleware, b1HANA.updateLead)

router.use('/invoice', invoiceRouter);

router.get('/search', authMiddleware, b1HANA.search);

router.post('/incomingPayment', authMiddleware, b1SL.postIncomingPayment);

router.post('/leads', authMiddleware, b1HANA.createLead);

router.post('/invoice', authMiddleware, b1SL.createInvoice);

router.get('/test', (req, res) => {
    res.json({ message: 'ok' });
});
module.exports = router
