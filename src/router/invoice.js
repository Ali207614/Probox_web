const Router = require('express').Router;
const b1SL = require('../controllers/b1SL');
const b1HANA = require('../controllers/b1HANA');
const authMiddleware = require('../middlewares/auth-middleware');
const router = new Router();


router.get('/', authMiddleware, b1HANA.invoice);


module.exports = router
