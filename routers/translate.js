const express = require('express');
const router = express.Router();
const { translateText } = require('../controllers/translate');

// POST /v1/translate - Metin çevirisi
router.post('/', translateText);

module.exports = router;

