const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const router = new Router();


router.get('/', authMiddleware, b1HANA.invoice);
router.get('/:id', authMiddleware, b1HANA.getPayList);


router.get('/search', authMiddleware, b1HANA.search);


module.exports = router
